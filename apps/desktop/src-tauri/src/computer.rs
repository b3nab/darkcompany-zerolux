//! This computer as one of other workspaces' computers: their person starts and follows
//! sessions here, with this computer's harnesses, through each workspace's kernel. Each joined
//! workspace keeps its link in a folder of its own, and stays connected while the app runs.

use anyhow::{Context, Result};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{Notify, mpsc, watch};
use zerolux::{
    claude_runner::RunnerProgram,
    host_link::{self, HostConfig, HostLinkState},
    host_runtime::HostRuntime,
};

/// A workspace this computer joined, as the manager shows it.
#[derive(Clone, Serialize)]
pub struct LinkView {
    pub id: String,
    pub url: String,
    /// Connecting, connected, or connecting again after a break; none once it stopped.
    pub link: Option<HostLinkState>,
    /// Why it stopped, as when the workspace removed this computer.
    pub error: Option<String>,
}

struct Link {
    url: String,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
    state: watch::Receiver<HostLinkState>,
    error: Arc<Mutex<Option<String>>>,
}

pub struct Links {
    root: PathBuf,
    links: HashMap<String, Link>,
    /// Told whenever a link's state changes or it stops, to show it.
    changed: Arc<Notify>,
}

impl Links {
    /// None connected yet: the joined workspaces kept under `root` wait.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            links: HashMap::new(),
            changed: Arc::new(Notify::new()),
        }
    }

    /// When a link's state has changed, or a link has stopped.
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    /// The workspaces joined before, under `root`, each connected again.
    pub fn start(root: PathBuf, program: &RunnerProgram) -> Self {
        let mut links = Self::new(root);
        if let Ok(entries) = std::fs::read_dir(&links.root) {
            for entry in entries.flatten() {
                if !HostConfig::path(&entry.path()).is_file() {
                    continue;
                }
                let id = entry.file_name().to_string_lossy().into_owned();
                if let Err(error) = links.connect(&id, program.clone()) {
                    eprintln!("A joined workspace could not connect: {error:#}");
                }
            }
        }
        links
    }

    /// Joins a workspace with the code its person made there, then stays connected. An empty
    /// name keeps the one given with the code.
    pub async fn join(
        &mut self,
        url: &str,
        code: &str,
        name: &str,
        program: RunnerProgram,
    ) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let folder = self.root.join(&id);
        if let Err(error) = host_link::join(url.trim(), code.trim(), name.trim(), &folder).await {
            let _ = std::fs::remove_dir_all(&folder);
            return Err(error);
        }
        self.connect(&id, program)
    }

    fn connect(&mut self, id: &str, program: RunnerProgram) -> Result<()> {
        let folder = self.root.join(id);
        let config = HostConfig::load(&folder)?;
        let url = config.url.clone();
        let (stop, stopped) = watch::channel(false);
        let (tell, told) = mpsc::unbounded_channel();
        let (report, state) = watch::channel(HostLinkState::Connecting);
        let host =
            HostRuntime::with_runners(url.clone(), folder.join("links"), None, program, tell);
        let error = Arc::new(Mutex::new(None));
        let failed = error.clone();
        let (changed, mut watched) = (self.changed.clone(), state.clone());
        let task = tokio::spawn(async move {
            let link = host_link::run_reporting(config, stopped, host, told, report);
            tokio::pin!(link);
            // Each state it reaches is shown; so is its end.
            let result = loop {
                tokio::select! {
                    result = &mut link => break result,
                    Ok(()) = watched.changed() => changed.notify_one(),
                }
            };
            if let Err(error) = result {
                *failed.lock().expect("link error lock") = Some(format!("{error:#}"));
            }
            changed.notify_one();
        });
        self.links.insert(
            id.to_owned(),
            Link {
                url,
                stop,
                task,
                state,
                error,
            },
        );
        Ok(())
    }

    /// Leaves a workspace: its connection closes and this computer forgets it. Its person
    /// removes the computer from the workspace's list there.
    pub async fn leave(&mut self, id: &str) -> Result<()> {
        let link = self
            .links
            .remove(id)
            .context("This computer is not in that workspace")?;
        link.stop.send_replace(true);
        let _ = link.task.await;
        std::fs::remove_dir_all(self.root.join(id)).context("Forget the workspace's link")
    }

    pub fn views(&self) -> Vec<LinkView> {
        let mut views: Vec<LinkView> = self
            .links
            .iter()
            .map(|(id, link)| LinkView {
                id: id.clone(),
                url: link.url.clone(),
                link: (!link.task.is_finished()).then(|| link.state.borrow().clone()),
                error: link.error.lock().expect("link error lock").clone(),
            })
            .collect();
        views.sort_by(|a, b| a.url.cmp(&b.url));
        views
    }

    pub async fn shutdown(self) {
        for link in self.links.values() {
            link.stop.send_replace(true);
        }
        for (_, link) in self.links {
            let _ = link.task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_computer_with_no_workspace_joined_has_nothing_to_leave() {
        let root = tempfile::tempdir().unwrap();
        // A folder without a link is not a workspace joined.
        std::fs::create_dir_all(root.path().join("stray")).unwrap();
        let mut links = Links::start(root.path().into(), &RunnerProgram::default());
        assert!(links.views().is_empty());
        assert!(links.leave("stray").await.is_err());
        links.shutdown().await;
    }
}
