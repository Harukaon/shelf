use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

const REPO_OWNER: &str = "Harukaon";
const REPO_NAME: &str = "shelf";
const REQUEST_TIMEOUT_SECS: u64 = 10;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub release_url: String,
    pub release_notes: String,
    pub published_at: String,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    // Pull from /releases (not /releases/latest) so we can skip drafts and
    // prereleases ourselves, and so this works even when no "Latest" has
    // been picked yet on the repo.
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=10",
        REPO_OWNER, REPO_NAME
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(format!("shelf/{} (update-check)", current))
        .build()
        .map_err(|e| format!("Build http client: {}", e))?;

    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Fetch releases: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub responded with status {}",
            resp.status().as_u16()
        ));
    }

    let releases: Vec<GhRelease> = resp
        .json()
        .await
        .map_err(|e| format!("Parse release list: {}", e))?;

    let latest = releases
        .into_iter()
        .find(|r| !r.draft && !r.prerelease)
        .ok_or_else(|| "No published release found".to_string())?;

    let latest_version = latest.tag_name.trim_start_matches('v').to_string();
    let has_update = compare_versions(&current, &latest_version) == Ordering::Less;

    Ok(UpdateInfo {
        current,
        latest: latest_version,
        has_update,
        release_url: latest.html_url,
        release_notes: latest.body,
        published_at: latest.published_at,
    })
}

/// Compare two dotted version strings (e.g. "0.2.7" vs "0.2.10"). Anything
/// after the last numeric segment is ignored, so "0.2.10-beta" parses as
/// [0, 2, 10] and beats "0.2.9".
fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |s: &str| -> Vec<u32> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|seg| !seg.is_empty())
            .filter_map(|seg| seg.parse::<u32>().ok())
            .collect::<Vec<_>>()
    };
    let mut left = parse(a);
    let mut right = parse(b);
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    left.cmp(&right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_basic() {
        assert_eq!(compare_versions("0.2.7", "0.2.8"), Ordering::Less);
        assert_eq!(compare_versions("0.2.8", "0.2.7"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.7", "0.2.7"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.10", "0.2.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0", "0.9.99"), Ordering::Greater);
    }

    #[test]
    fn compare_with_prefix_and_suffix() {
        assert_eq!(compare_versions("v0.2.7", "v0.2.8"), Ordering::Less);
        assert_eq!(compare_versions("0.2.7", "0.2.7-beta"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.7", "0.2.8-rc1"), Ordering::Less);
    }
}
