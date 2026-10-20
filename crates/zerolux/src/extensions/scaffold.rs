//! A new extension, ready to run: its manifest, a first action, and the SDK of its language in
//! one file beside it, so it needs nothing from a registry.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use super::manifest::{FILE, Manifest};

/// The SDKs, as one file each, carried by the kernel.
const TYPESCRIPT_SDK: &str = include_str!("../../../../packages/extension-sdk/src/index.ts");
const PYTHON_SDK: &str = include_str!("../../../../packages/extension-sdk/python/zerolux.py");

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Language {
    Typescript,
    Python,
}

/// Writes a new extension `id` (`publisher.name`) into `folder`, which must not exist or be
/// empty: its manifest, its `main` file with one action, and the SDK.
pub fn create(id: &str, name: &str, language: Language, folder: &Path) -> Result<PathBuf> {
    let (publisher, _) = id.split_once('.').unwrap_or((id, ""));
    let command = match language {
        Language::Typescript => r#"["bun", "run", "main.ts"]"#,
        Language::Python => r#"["uv", "run", "--script", "main.py"]"#,
    };
    let manifest = format!(
        "[extension]\nid = {id:?}\nname = {name:?}\nversion = \"0.1.0\"\npublisher = {publisher:?}\ndescription = \"\"\n\n[process]\ncommand = {command}\n"
    );
    Manifest::parse(&manifest).map_err(anyhow::Error::from)?;
    if folder.exists()
        && std::fs::read_dir(folder)
            .with_context(|| format!("Cannot read {}", folder.display()))?
            .next()
            .is_some()
    {
        bail!("{} is not empty", folder.display());
    }
    std::fs::create_dir_all(folder)
        .with_context(|| format!("Cannot create {}", folder.display()))?;
    let files: [(&str, String); 3] = match language {
        Language::Typescript => [
            (FILE, manifest),
            ("main.ts", typescript_main()),
            ("zerolux.ts", TYPESCRIPT_SDK.to_owned()),
        ],
        Language::Python => [
            (FILE, manifest),
            ("main.py", python_main(name)),
            ("zerolux.py", PYTHON_SDK.to_owned()),
        ],
    };
    for (file, text) in files {
        std::fs::write(folder.join(file), text).with_context(|| format!("Cannot write {file}"))?;
    }
    Ok(dunce::canonicalize(folder)?)
}

fn typescript_main() -> String {
    r#"import { defineExtension, serve } from "./zerolux.ts";

await serve(
  defineExtension({
    actions: {
      hello: {
        title: "Say hello",
        description: "Greets whoever runs it",
        input: { type: "object", properties: { name: { type: "string" } } },
        run: (input: { name?: string }, context) => ({
          text: `Hello, ${input.name ?? context.caller.actor_id ?? "there"}`,
        }),
      },
    },
  }),
);
"#
    .to_owned()
}

fn python_main(name: &str) -> String {
    format!(
        r#"# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""{name}: a ZeroLux extension."""

from zerolux import Extension

extension = Extension()


@extension.action("hello", "Say hello", "Greets whoever runs it",
                  input={{"type": "object", "properties": {{"name": {{"type": "string"}}}}}})
def hello(input, caller):
    return {{"text": f"Hello, {{input.get('name') or caller.get('actor_id') or 'there'}}"}}


if __name__ == "__main__":
    extension.serve()
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_extension_is_a_valid_folder_and_never_overwrites_one() {
        let dir = tempfile::tempdir().unwrap();
        for (language, main) in [
            (Language::Typescript, "main.ts"),
            (Language::Python, "main.py"),
        ] {
            let folder = dir.path().join(format!("{language:?}"));
            create("acme.hello", "Hello", language, &folder).unwrap();
            let manifest =
                Manifest::parse(&std::fs::read_to_string(folder.join(FILE)).unwrap()).unwrap();
            assert_eq!(manifest.extension.publisher, "acme");
            assert!(folder.join(main).is_file());
            assert!(create("acme.hello", "Hello", language, &folder).is_err());
        }
        assert!(create("Not An Id", "x", Language::Python, &dir.path().join("bad")).is_err());
        assert!(!dir.path().join("bad").exists());
    }
}
