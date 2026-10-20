//! Terminals the owner opens in a session's folder: a shell in a pseudo-terminal on the kernel
//! host, its output kept while it runs and read by offset, like a session's native record.

use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

/// The person's shell: their login shell on Unix, PowerShell on Windows.
fn shell() -> CommandBuilder {
    #[cfg(unix)]
    {
        let mut command =
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        command.arg("-l");
        command
    }
    #[cfg(windows)]
    {
        let pwsh = crate::platform::executable("pwsh");
        let mut command = CommandBuilder::new(if pwsh.is_absolute() {
            pwsh
        } else {
            "powershell.exe".into()
        });
        command.arg("-NoLogo");
        command
    }
}
use serde::Serialize;
use tokio::sync::mpsc;

use crate::store::Error;

/// Output kept per terminal: its latest bytes.
const KEPT: usize = 1024 * 1024;
/// Output returned at most per read.
const READ: usize = 256 * 1024;
const TERMINALS: usize = 20;

/// A terminal, as the API shows it.
#[derive(Debug, Clone, Serialize)]
pub struct Info {
    pub id: String,
    pub session_id: String,
    pub folder: String,
    pub cols: u16,
    pub rows: u16,
    /// How much output it has produced: the offset its next byte will have.
    pub end: u64,
    /// The shell's exit code, once it has ended.
    pub exit_code: Option<u32>,
    pub ended: bool,
}

/// Output from `start`, base64-encoded, and where the next read starts.
#[derive(Debug, Clone, Serialize)]
pub struct Output {
    /// Where the output kept now begins: what came before it is gone.
    pub start: u64,
    pub data: String,
    pub next: u64,
    pub ended: bool,
}

struct Terminal {
    info: Mutex<Info>,
    output: Mutex<(u64, VecDeque<u8>)>,
    writer: Mutex<Box<dyn Write + Send>>,
    /// The terminal's side of the console; closed once its shell has ended.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

/// The open terminals. `grown` hears of each terminal whose output grew or that ended.
pub struct Terminals {
    open: Mutex<HashMap<String, Arc<Terminal>>>,
    grown: mpsc::UnboundedSender<String>,
}

impl Terminals {
    pub fn new(grown: mpsc::UnboundedSender<String>) -> Self {
        Self {
            open: Mutex::new(HashMap::new()),
            grown,
        }
    }

    /// Opens the owner's login shell in `folder`.
    pub fn open(&self, session_id: &str, folder: &str, cols: u16, rows: u16) -> Result<Info> {
        if self.open.lock().expect("terminals").len() >= TERMINALS {
            return Err(Error::Invalid("Close a terminal before opening another".into()).into());
        }
        let size = PtySize {
            rows: rows.clamp(2, 500),
            cols: cols.clamp(2, 1000),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .context("Cannot open a terminal")?;
        let mut command = shell();
        command.cwd(folder);
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .context("Cannot start a shell")?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let id = uuid::Uuid::new_v4().to_string();
        let info = Info {
            id: id.clone(),
            session_id: session_id.to_owned(),
            folder: folder.to_owned(),
            cols: size.cols,
            rows: size.rows,
            end: 0,
            exit_code: None,
            ended: false,
        };
        let terminal = Arc::new(Terminal {
            info: Mutex::new(info.clone()),
            output: Mutex::new((0, VecDeque::new())),
            writer: Mutex::new(writer),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(child.clone_killer()),
        });
        self.open
            .lock()
            .expect("terminals")
            .insert(id.clone(), terminal.clone());
        // The shell's end: the console is closed then, which also ends its output on Windows,
        // where the output stays open as long as the console does.
        let (ending, grown_end, id_end) = (terminal.clone(), self.grown.clone(), id.clone());
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            {
                let mut info = ending.info.lock().expect("info");
                info.ended = true;
                info.exit_code = code;
            }
            ending.master.lock().expect("master").take();
            let _ = grown_end.send(id_end);
        });
        let grown = self.grown.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                {
                    let mut output = terminal.output.lock().expect("output");
                    output.1.extend(&buffer[..read]);
                    let excess = output.1.len().saturating_sub(KEPT);
                    output.1.drain(..excess);
                    output.0 += excess as u64;
                    terminal.info.lock().expect("info").end = output.0 + output.1.len() as u64;
                }
                let _ = grown.send(id.clone());
            }
        });
        Ok(info)
    }

    fn get(&self, id: &str) -> Result<Arc<Terminal>, Error> {
        self.open
            .lock()
            .expect("terminals")
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }

    pub fn info(&self, id: &str) -> Result<Info, Error> {
        Ok(self.get(id)?.info.lock().expect("info").clone())
    }

    /// A session's terminals, oldest first.
    pub fn of(&self, session_id: &str) -> Vec<Info> {
        let mut found: Vec<Info> = self
            .open
            .lock()
            .expect("terminals")
            .values()
            .map(|terminal| terminal.info.lock().expect("info").clone())
            .filter(|info| info.session_id == session_id)
            .collect();
        found.sort_by(|a, b| a.id.cmp(&b.id));
        found
    }

    /// Output from `after`, or from where the kept output begins if that is gone.
    pub fn output(&self, id: &str, after: u64) -> Result<Output, Error> {
        use base64::Engine;
        let terminal = self.get(id)?;
        let output = terminal.output.lock().expect("output");
        let (start, bytes) = (&output.0, &output.1);
        let end = start + bytes.len() as u64;
        if after > end {
            return Err(Error::Invalid(
                "Read from an offset the terminal has reached".into(),
            ));
        }
        let from = after.max(*start);
        let skip = (from - start) as usize;
        let data: Vec<u8> = bytes.iter().skip(skip).take(READ).copied().collect();
        let next = from + data.len() as u64;
        Ok(Output {
            start: *start,
            data: base64::engine::general_purpose::STANDARD.encode(data),
            next,
            ended: terminal.info.lock().expect("info").ended && next == end,
        })
    }

    /// What the owner types, as the terminal receives it.
    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        if data.len() > 64 * 1024 {
            return Err(Error::Invalid("Type up to 64 KiB at a time".into()).into());
        }
        let terminal = self.get(id)?;
        if terminal.info.lock().expect("info").ended {
            return Err(Error::Invalid("The terminal has ended".into()).into());
        }
        let mut writer = terminal.writer.lock().expect("writer");
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<Info> {
        let terminal = self.get(id)?;
        let (cols, rows) = (cols.clamp(2, 1000), rows.clamp(2, 500));
        terminal
            .master
            .lock()
            .expect("master")
            .as_ref()
            .context("The terminal has ended")?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("The terminal was not resized")?;
        let mut info = terminal.info.lock().expect("info");
        info.cols = cols;
        info.rows = rows;
        Ok(info.clone())
    }

    /// Ends the shell, if it still runs, and forgets the terminal.
    pub fn close(&self, id: &str) -> Result<(), Error> {
        let terminal = self
            .open
            .lock()
            .expect("terminals")
            .remove(id)
            .ok_or(Error::NotFound)?;
        if !terminal.info.lock().expect("info").ended {
            let _ = terminal.killer.lock().expect("killer").kill();
        }
        Ok(())
    }

    /// The session's terminals end with it.
    pub fn close_all(&self, session_id: &str) {
        for info in self.of(session_id) {
            let _ = self.close(&info.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    async fn read_until(terminals: &Terminals, id: &str, wanted: &str) -> String {
        let mut text = String::new();
        let mut after = 0;
        for _ in 0..200 {
            let output = terminals.output(id, after).unwrap();
            after = output.next;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(output.data)
                .unwrap();
            let piece = String::from_utf8_lossy(&bytes);
            // Windows' console asks where the cursor is before it starts, and waits for the
            // answer a terminal on screen gives.
            if piece.contains("\u{1b}[6n") {
                terminals.write(id, "\u{1b}[1;1R").unwrap();
            }
            text.push_str(&piece);
            if text.contains(wanted) {
                return text;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("terminal output never had {wanted:?}: {text:?}");
    }

    #[tokio::test]
    async fn a_shell_runs_in_the_folder_and_its_output_is_read_by_offset() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dunce::canonicalize(dir.path()).unwrap();
        let (grown, mut heard) = mpsc::unbounded_channel();
        let terminals = Terminals::new(grown);
        let info = terminals
            .open("session", &folder.to_string_lossy(), 80, 24)
            .unwrap();
        assert_eq!(terminals.of("session").len(), 1);
        // The same line in a Unix shell and in PowerShell.
        let line = if cfg!(windows) {
            "echo \"here-$(40+2)\"; pwd\r\n"
        } else {
            "echo here-$((40+2)); pwd\n"
        };
        terminals.write(&info.id, line).unwrap();
        read_until(&terminals, &info.id, "here-42").await;
        read_until(&terminals, &info.id, &folder.to_string_lossy()).await;
        assert!(heard.recv().await.is_some());
        assert_eq!(terminals.resize(&info.id, 100, 30).unwrap().cols, 100);
        assert!(terminals.output(&info.id, u64::MAX).is_err());
        terminals
            .write(&info.id, if cfg!(windows) { "exit\r\n" } else { "exit\n" })
            .unwrap();
        let mut after = terminals.info(&info.id).unwrap().end;
        for _ in 0..200 {
            if terminals.info(&info.id).unwrap().ended {
                break;
            }
            // Its console may ask where the cursor is again, as a prompt is drawn.
            let output = terminals.output(&info.id, after).unwrap();
            after = output.next;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(output.data)
                .unwrap();
            if String::from_utf8_lossy(&bytes).contains("\u{1b}[6n") {
                let _ = terminals.write(&info.id, "\u{1b}[1;1R");
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(terminals.info(&info.id).unwrap().ended);
        assert!(terminals.write(&info.id, "ls\n").is_err());
        terminals.close(&info.id).unwrap();
        assert!(terminals.of("session").is_empty());
    }
}
