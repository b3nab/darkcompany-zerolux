//! Paths within a location: `a/b/c`, the top empty, never leaving it.

pub fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\'])
        || name == "."
        || name == ".."
    {
        return Err("A name is 1 to 255 bytes, without slashes".into());
    }
    Ok(name.to_owned())
}

/// A path as `a/b`, without empty or dot parts; the top is empty.
pub fn clean_path(path: &str) -> Result<String, String> {
    let parts: Vec<&str> = path
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts
        .iter()
        .any(|part| *part == "." || *part == ".." || part.contains('\\'))
        || path.len() > 4096
    {
        return Err("Invalid path".into());
    }
    Ok(parts.join("/"))
}

pub fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_owned()
    } else {
        format!("{folder}/{name}")
    }
}

pub fn leaf(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn parent(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

/// The name, or the name with a number when it is taken: `report (2).pdf`.
pub fn free_name(name: &str, taken: &[String]) -> String {
    if !taken.iter().any(|known| known == name) {
        return name.to_owned();
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| format!("{stem} ({n}){extension}"))
        .find(|candidate| !taken.iter().any(|known| known == candidate))
        .expect("a free name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_names_stay_within_a_location() {
        assert_eq!(clean_path(" a / b /").unwrap(), "a/b");
        assert_eq!(clean_path("").unwrap(), "");
        assert!(clean_path("a/../b").is_err());
        assert!(clean_name("a/b").is_err());
        assert!(clean_name("..").is_err());
        assert_eq!(clean_name(" report.pdf ").unwrap(), "report.pdf");
        assert_eq!(join("", "a"), "a");
        assert_eq!(join("a/b", "c"), "a/b/c");
        assert_eq!(leaf("a/b/c.txt"), "c.txt");
        assert_eq!(parent("a/b/c.txt"), "a/b");
        assert_eq!(parent("c.txt"), "");
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let taken = vec!["report.pdf".to_owned(), "report (2).pdf".to_owned()];
        assert_eq!(free_name("report.pdf", &taken), "report (3).pdf");
        assert_eq!(free_name("notes", &["notes".to_owned()]), "notes (2)");
        assert_eq!(free_name("new.txt", &taken), "new.txt");
    }
}
