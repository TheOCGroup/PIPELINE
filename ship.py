#!/usr/bin/env python3
"""Ship the pipeline continuation delta via GitHub REST API (authd surrogate).
Usage: ship.py <repo_dir> <branch_name> <commit_message>
Commits ALL staged+unstaged tracked modifications and untracked files present
in <repo_dir> working tree relative to main HEAD.
"""
import sys, os, json, base64, urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CRED = "custom.github"
HOSTS = ("api.github.com",)
BASE = "https://api.github.com"
OWNER_REPO = "TheOCGroup/PIPELINE"


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=(json.dumps(body).encode() if body is not None else None),
        method=method,
        headers={"Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "Content-Type": "application/json"},
    )
    add_surrogate_to_request(req, CRED, entry_name="access_token", allowed_hosts=HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw.decode()) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:500].decode(errors="replace")


def main():
    repo_dir, branch, message = sys.argv[1], sys.argv[2], sys.argv[3]
    os.chdir(repo_dir)

    # main HEAD sha
    s, r = api("GET", f"/repos/{OWNER_REPO}/git/ref/heads/main")
    assert s == 200, f"main ref: {s} {r}"
    main_sha = r["object"]["sha"]
    print("main:", main_sha)

    # main tree sha
    s, r = api("GET", f"/repos/{OWNER_REPO}/git/commits/{main_sha}")
    assert s == 200, f"main commit: {s} {r}"
    base_tree = r["tree"]["sha"]

    # collect changed/new files vs main (tracked mods + untracked, excluding node_modules)
    import subprocess
    out = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True).stdout
    files = []
    for line in out.splitlines():
        st, path = line[:2], line[3:]
        if path.startswith("node_modules"): continue
        if st.strip() in ("M", "A", "??"):
            files.append(path)
    print("files:", files)
    assert files, "no changes to ship"

    # create blobs
    tree_entries = []
    for path in sorted(files):
        with open(path, "rb") as f:
            content = f.read()
        try:
            text = content.decode("utf-8")
            blob_body = {"content": text, "encoding": "utf-8"}
        except UnicodeDecodeError:
            blob_body = {"content": base64.b64encode(content).decode(), "encoding": "base64"}
        s, r = api("POST", f"/repos/{OWNER_REPO}/git/blobs", blob_body)
        assert s == 201, f"blob {path}: {s} {r}"
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": r["sha"]})
        print("blob:", path, r["sha"][:8])

    # new tree
    s, r = api("POST", f"/repos/{OWNER_REPO}/git/trees",
               {"base_tree": base_tree, "tree": tree_entries})
    assert s == 201, f"tree: {s} {r}"
    tree_sha = r["sha"]
    print("tree:", tree_sha)

    # commit
    s, r = api("POST", f"/repos/{OWNER_REPO}/git/commits",
               {"message": message, "tree": tree_sha, "parents": [main_sha]})
    assert s == 201, f"commit: {s} {r}"
    commit_sha = r["sha"]
    print("commit:", commit_sha)

    # branch ref
    s, r = api("POST", f"/repos/{OWNER_REPO}/git/refs",
               {"ref": f"refs/heads/{branch}", "sha": commit_sha})
    assert s == 201, f"ref: {s} {r}"
    print("branch created:", branch)
    print(json.dumps({"branch": branch, "commit": commit_sha, "base": main_sha}))


if __name__ == "__main__":
    main()
