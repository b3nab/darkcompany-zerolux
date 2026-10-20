use super::*;
use crate::platform::Canonical;

struct Fixture {
    root: tempfile::TempDir,
    registry: Registry,
    native: String,
}
impl Fixture {
    fn new(description: Value) -> Self {
        let root = tempfile::Builder::new()
            .prefix("zcg-")
            .tempdir_in("/tmp")
            .unwrap();
        let code = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/bridge/src")
            .canonical()
            .unwrap();
        let entry = root.path().join("fixture.ts");
        std::fs::write(&entry, format!(r#"
import {{ LocalControl }} from {control};
import {{ acquireSessionLock }} from {lock};
import {{ join }} from 'node:path';
const native = process.env.ZEROLUX_NATIVE_SESSION;
const registry = process.env.ZEROLUX_RUNNER_REGISTRY;
const lease = acquireSessionLock(join(registry, `${{native}}.lock`));
if (!lease) process.exit(3);
lease.write(JSON.stringify({{pid:process.pid}}));
const control = new LocalControl(registry, {{
  describe: () => ({{kind:'claude-runner', native_session_id:native,
    workspace:process.env.ZEROLUX_WORKSPACE, permission_mode:'default', bound:false, ...{description}}}),
  handle: async (method) => {{
    if (method === 'bind') {{
      await Bun.write(join(process.env.ZEROLUX_WORKSPACE, 'bind-received'), 'fixture');
      return {{link_id:'link'}}; // No SDK/native/input: only handshake coverage.
    }}
    if (method !== 'fixture-exit') throw new Error('Unexpected fixture operation');
    setTimeout(() => process.exit(0), 10);
    return {{}};
  }}
}}, 'guard');
await control.start();
setTimeout(() => process.exit(0), 20000); // Only this disposable fake host; no native/model is spawned.
"#, control=serde_json::to_string(&code.join("local-control.ts")).unwrap(), lock=serde_json::to_string(&code.join("session-lock.ts")).unwrap())).unwrap();
        let bun = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|dir| dir.join("bun"))
            .find(|file| file.is_file())
            .unwrap()
            .canonical()
            .unwrap();
        let wrapper = root.path().join("bun-fixture");
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec /usr/bin/env -i HOME=\"{root}\" TMPDIR=\"{root}\" PATH=/usr/bin:/bin ZEROLUX_RUNNER_REGISTRY=\"$ZEROLUX_RUNNER_REGISTRY\" ZEROLUX_NATIVE_SESSION=\"$ZEROLUX_NATIVE_SESSION\" ZEROLUX_WORKSPACE=\"$ZEROLUX_WORKSPACE\" ZEROLUX_CLAUDE_MANAGED=\"$ZEROLUX_CLAUDE_MANAGED\" \"{bun}\" \"$@\"\n", root=root.path().display(), bun=bun.display())).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let program = RunnerProgram {
            bun: wrapper,
            entry,
            ..RunnerProgram::default()
        };
        let registry = Registry::new(root.path().join("links"), program);
        registry.prepare_directory().unwrap();
        Self {
            root,
            registry,
            native: Uuid::new_v4().to_string(),
        }
    }
    fn workspace(&self) -> &str {
        self.root.path().to_str().unwrap()
    }
    async fn exit(&self, link: &RunnerLink) {
        link.request(json!({"method":"fixture-exit"}))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.registry.is_leased(&self.native).unwrap() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn only_its_own_guarded_waiting_host_can_satisfy_a_new_launch() {
    let guarded = json!({"native_guard":1,"native_phase":"waiting","native_pid":null});
    for (description, accepted) in [
        (json!({}), false), // An old asset silently ignores MANAGED=1.
        (
            json!({"native_guard":2,"native_phase":"waiting","native_pid":null}),
            false,
        ),
        (json!({"native_guard":1,"native_phase":"waiting"}), false), // Unknown is not null.
        (
            json!({"native_guard":1,"native_phase":"running","native_pid":123}),
            false,
        ),
        (
            json!({"native_guard":1,"native_phase":"waiting","native_pid":null,"bound":true}),
            false,
        ),
        (
            json!({"native_guard":1,"native_phase":"waiting","native_pid":null,"pid":std::process::id()}),
            false,
        ),
        (guarded, true),
    ] {
        let f = Fixture::new(description.clone());
        let result = f
            .registry
            .launch(
                &f.native,
                f.workspace(),
                PermissionMode::Default,
                None,
                &AgentSettings::default(),
                &crate::homes::Homes::own(),
            )
            .await;
        // Even the red test cleans up ONLY its authenticated fixture, not descriptor PID.
        if let Ok(link) = &result {
            f.exit(link).await;
        }
        assert_eq!(
            result.is_ok(),
            accepted,
            "Unexpected launch result for {description}"
        );
        assert!(!f.registry.is_leased(&f.native).unwrap());
    }
}

#[tokio::test]
async fn warm_bind_reuses_authenticated_legacy_and_managed_hosts() {
    for (description, accepted) in [
        (json!({"bound":true}), true),
        (json!({"bound":false}), true),
        (json!({"bound":false,"started":false}), true),
        (json!({"bound":true,"started":true}), true),
        (json!({"bound":false,"started":true}), true), // Revoked/paused transport, same live query.
        (
            json!({"bound":false,"started":false,"native_guard":1}),
            true,
        ),
    ] {
        let f = Fixture::new(description.clone());
        let mut child = tokio::process::Command::new(&f.registry.program.bun)
            .arg(&f.registry.program.entry)
            .env("ZEROLUX_RUNNER_REGISTRY", &f.registry.path)
            .env("ZEROLUX_NATIVE_SESSION", &f.native)
            .env("ZEROLUX_WORKSPACE", f.workspace())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let link = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(link) = f
                    .registry
                    .find(&f.native, f.workspace(), PermissionMode::Default)
                    .await
                    .unwrap()
                {
                    break link;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(link.bound, description["bound"] == true);
        let result = link
            .bind(
                "http://127.0.0.1:9",
                "FAKE_TOKEN",
                "link",
                Path::new("/fixture"),
                true,
            )
            .await;
        f.exit(&link).await;
        assert!(child.wait().await.unwrap().success());
        assert_eq!(
            result.is_ok(),
            accepted,
            "Unexpected bind result for {description}"
        );
        assert_eq!(
            f.root.path().join("bind-received").exists(),
            accepted,
            "The existing host owns its query lifecycle"
        );
    }
}
