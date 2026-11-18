"""户型装修设计 · 一键发布脚本（参照 fnmonitorpro/release.py 的验证流程）

流程：构建全平台安装包 -> 打版本标签并推送 -> 创建 GitHub Release 并上传产物。
产物（5 个）：fnOS x86/arm fpk、Windows zip、Linux/macOS tar.gz
发布说明：自动读取 CHANGELOG.md 中对应版本的条目；发布成功后把「（开发中）」标为发布日期，并预留下一版本的开发中标题。
用法：python release.py [版本号]        （缺省读 manifest 的 version=）
凭据：优先 .env 中的 GITHUB_TOKEN（不依赖 gh CLI）；其次 gh（需已登录）。
"""
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = "RONGLINC93/floorplan-3d"
MANIFEST = ROOT / "manifest"
BUILDERS = ["pack_fpk.py", "pack_win.py", "pack_linux.py", "pack_mac.py"]


def artifacts(ver):
    return [ROOT / f"floorplan3d-{ver}-fnos-x86.fpk",
            ROOT / f"floorplan3d-{ver}-fnos-arm.fpk",
            ROOT / f"floorplan3d-{ver}-windows.zip",
            ROOT / f"floorplan3d-{ver}-linux.tar.gz",
            ROOT / f"floorplan3d-{ver}-macos.tar.gz"]


def load_env(path):
    data = {}
    if not path.exists():
        return data
    for line in io.open(path, encoding="utf-8", errors="ignore"):
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            data[k.strip()] = v.strip().strip("'").strip('"')
    return data


def git_auth_args():
    tok = load_env(ROOT / ".env").get("GITHUB_TOKEN", "")
    if tok:
        b64 = base64.b64encode(("x-access-token:" + tok).encode("utf-8")).decode("ascii")
        return ["-c", "http.https://github.com/.extraheader=AUTHORIZATION: basic " + b64]
    return []


def run(cmd):
    print("> " + " ".join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd]).returncode


def read_version():
    if MANIFEST.exists():
        m = re.search(r"(?m)^version=([0-9].*)$", MANIFEST.read_text(encoding="utf-8"))
        if m:
            return m.group(1).strip()
    return ""


def changelog_section(ver):
    """取出 CHANGELOG.md 里 v{ver} 的正文（不含标题），作为 Release 说明。"""
    p = ROOT / "CHANGELOG.md"
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8")
    m = re.search(r"(?ms)^##\s*v?" + re.escape(ver) + r"[^\n]*\n(.*?)(?=^##\s|\Z)", text)
    return m.group(1).strip() if m else ""


def finalize_changelog(ver, nv=None):
    """发布成功：把 CHANGELOG 的「（开发中）」标成发布日期，并预留下一版本的开发中标题。"""
    p = ROOT / "CHANGELOG.md"
    if not p.exists():
        print("[提示] 未找到 CHANGELOG.md，跳过更新日志标记")
        return False
    text = p.read_text(encoding="utf-8")
    nt = re.sub(r"(?m)^##\s*v?" + re.escape(ver) + r"\s*（开发中）",
                f"## v{ver}（{date.today().isoformat()}）", text, count=1)
    if nv and not re.search(r"(?m)^##\s*v" + re.escape(nv) + r"\b", nt):
        m = re.search(r"(?m)^##\s", nt)
        if m:
            nt = nt[:m.start()] + f"## v{nv}（开发中）\n\n" + nt[m.start():]
    if nt == text:
        return False
    p.write_text(nt, encoding="utf-8")
    print(f"[日志] CHANGELOG.md 已更新：v{ver} 标记发布日期" + (f"，新增 v{nv}（开发中）" if nv else ""))
    return True


def bump_version(ver):
    """发布成功后：manifest 的 version= 自动叠加一位（patch +1），作为下次发布的默认版本；网页状态栏的 APP_VER 同步。"""
    m = re.match(r"(\d+)\.(\d+)\.(\d+)$", ver)
    if not m:
        print(f"[提示] 版本号 {ver} 不是三段数字，manifest 版本号不自动叠加")
        return None
    nv = f"{m.group(1)}.{m.group(2)}.{int(m.group(3)) + 1}"
    MANIFEST.write_text(re.sub(r"(?m)^version=.*$", "version=" + nv,
                               MANIFEST.read_text(encoding="utf-8"), count=1),
                        encoding="utf-8")
    for f in [ROOT / "index.html", ROOT / "app" / "www" / "index.html"]:
        if f.exists():
            t = f.read_text(encoding="utf-8")
            nt = re.sub(r"const APP_VER = '[\d.]+';", f"const APP_VER = '{nv}';", t, count=1)
            if nt != t:
                f.write_text(nt, encoding="utf-8")
    print(f"[版本] manifest 与网页 APP_VER 已叠加：{ver} → {nv}")
    return nv


def commit_bump(nv):
    """把叠加后的版本号与更新日志提交并推送（失败不阻断，留待下次 push.py 一起提交）。"""
    if run(["git", "add", "manifest", "index.html", "CHANGELOG.md"]) != 0:
        print("[警告] git add 部分失败，继续提交已暂存的改动")
    if run(["git", "diff", "--cached", "--quiet"]) == 0:
        print("[提示] 无已暂存改动，跳过提交")
        return
    if run(["git", "commit", "-m", f"chore: 发布完成，manifest 版本号自动叠加至 {nv}"]) != 0:
        return
    run(["git"] + git_auth_args() + ["push", "origin", "main"])


def build_all(ver):
    """1/3 构建全平台产物。"""
    print("=== 1/3 构建全平台安装包 ===")
    for b in BUILDERS:
        if run([sys.executable, ROOT / b, ver]) != 0:
            print(f"[错误] {b} 构建失败")
            return False
    missing = [p for p in artifacts(ver) if not p.exists()]
    for p in missing:
        print("[错误] 缺少构建产物：" + p.name)
    return not missing


def push_tag(ver):
    """2/3 打版本标签并推送。"""
    print("")
    print(f"=== 2/3 创建并推送版本标签 v{ver} ===")
    run(["git", "tag", "-a", f"v{ver}", "-m", f"v{ver}"])
    rc = run(["git"] + git_auth_args() + ["push", "origin", f"v{ver}"])
    if rc != 0:
        print("[警告] 标签推送失败（若远程已存在该标签可忽略）")
    return rc == 0


def api(url, token, data=None, method=None, ctype="application/json"):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("User-Agent", "floorplan3d-release")
    req.add_header("Accept", "application/vnd.github+json")
    if data is not None:
        req.add_header("Content-Type", ctype)
    return json.loads(urllib.request.urlopen(req, timeout=300).read().decode("utf-8"))


def release_notes(ver, hashes):
    body = changelog_section(ver)
    lines = [f"## 户型装修设计 v{ver}", ""]
    if body:
        lines += [body, ""]
    lines += ["### 安装包", "",
              "| 产物 | 适用平台 | 大小 | SHA256 |", "|---|---|---|---|"]
    plat = {"fnos-x86.fpk": "飞牛 fnOS（x86）", "fnos-arm.fpk": "飞牛 fnOS（ARM）",
            "windows": "Windows", "linux": "Linux", "macos": "macOS"}
    for name, sha, size in hashes:
        key = next((k for k in plat if k in name), "")
        lines.append(f"| {name} | {plat.get(key, '')} | {size / 1024 / 1024:.1f} MB | {sha[:16]}... |")
    lines += ["", "**安装说明**",
              "- 飞牛 fnOS：应用中心 → 手动安装 → 按 NAS 架构选择 fpk",
              "- Windows：解压后双击 `启动服务器.bat`（需装有 Python 3）",
              "- Linux：`./start.sh`（需 python3）",
              "- macOS：解压后双击 `start.command`（需 python3）",
              "", f"完整更新日志：[CHANGELOG.md](https://github.com/{REPO}/blob/main/CHANGELOG.md)",
              "", "纯 Python 标准库实现，无第三方依赖；仅供学习交流使用。"]
    return "\n".join(lines)


def github_release(ver):
    """3/3 创建 Release 并上传全部产物（Token 或 gh）。"""
    print("")
    print("=== 3/3 创建 GitHub Release 并上传产物 ===")
    arts = artifacts(ver)
    hashes = [(p.name, hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_size)
              for p in arts]
    notes = release_notes(ver, hashes)
    # 附带应用图标（供发布页/第三方源 icon_url 引用），存在才上传，不计入发布说明表格
    icons = [p for p in (ROOT / "ICON.PNG", ROOT / "ICON_256.PNG") if p.exists()]
    arts += icons
    for name, sha, _ in hashes:
        print(f"  {name}  sha256={sha[:16]}...")

    tok = load_env(ROOT / ".env").get("GITHUB_TOKEN", "")
    if tok:
        cfg = load_env(ROOT / ".env")
        slug = cfg.get("GITHUB_REPO_URL", "")
        slug = "/".join(slug.rstrip("/").split("/")[-2:]).replace(".git", "") if slug else REPO
        root_url = "https://api.github.com/repos/" + slug
        up_url = "https://uploads.github.com/repos/" + slug
        try:
            me = api("https://api.github.com/user", tok)
            print("[凭据] 有效，登录用户：" + str(me.get("login")))
        except urllib.error.HTTPError as e:
            print(f"[错误] Token 无效（HTTP {e.code}）")
            return 1
        tag = "v" + ver
        try:
            rel = api(root_url + "/releases/tags/" + tag, tok)
            print(f"[Release] 已存在：id={rel.get('id')}")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                print(f"[错误] 查询 Release 失败 HTTP {e.code}")
                return 1
            rel = api(root_url + "/releases", tok, data=json.dumps({
                "tag_name": tag, "name": tag, "body": notes,
                "draft": False, "prerelease": False}).encode("utf-8"), method="POST")
            print(f"[Release] 创建成功：id={rel.get('id')}")
        existing = {a["name"] for a in api(root_url + f"/releases/{rel['id']}/assets", tok)}
        if rel.get("body") != notes:
            api(root_url + f"/releases/{rel['id']}", tok,
                data=json.dumps({"body": notes}).encode("utf-8"), method="PATCH")
        for p in arts:
            if p.name in existing:
                print("[资产] 已存在同名资产，跳过：" + p.name)
                continue
            url = f"{up_url}/releases/{rel['id']}/assets?name=" + urllib.parse.quote(p.name)
            out = api(url, tok, data=p.read_bytes(), method="POST",
                      ctype="application/octet-stream")
            print(f"[资产] 已上传：{out.get('name')}  {out.get('size')} bytes")
        rel = api(root_url + "/releases/tags/" + tag, tok)
        print("")
        print("[成功] Release 地址：" + str(rel.get("html_url")))
        return 0

    gh_ok = subprocess.run(["where", "gh"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL).returncode == 0 and \
        subprocess.run(["gh", "auth", "status"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL).returncode == 0
    if gh_ok:
        print("[凭据] 使用 gh CLI")
        if run(["gh", "release", "view", f"v{ver}", "--repo", REPO]) != 0:
            run(["gh", "release", "create", f"v{ver}"] + arts +
                ["--repo", REPO, "--title", f"v{ver}", "--notes", notes])
        else:
            run(["gh", "release", "upload", f"v{ver}"] + arts + ["--clobber", "--repo", REPO])
        return 0

    print("[跳过] 无可用凭据（.env 无 GITHUB_TOKEN，且 gh 未安装/未登录）")
    print("        办法一：在 .env 中配置 GITHUB_TOKEN=xxx（需 repo 权限）")
    print("        办法二：winget install GitHub.cli 然后 gh auth login")
    print(f"        办法三：手动创建 https://github.com/{REPO}/releases/new（标签 v{ver}）并上传：")
    for p in arts:
        print("          " + p.name)
    return 1


def main():
    os.chdir(ROOT)
    ver = sys.argv[1] if len(sys.argv) > 1 else read_version()
    if not ver:
        print("[错误] 无法读取版本号，请显式指定：python release.py 1.0.2")
        return 1
    print(f"[信息] 发布版本：v{ver}，目标仓库：{REPO}")
    if not changelog_section(ver):
        print(f"[提示] CHANGELOG.md 中没有找到 v{ver} 的更新内容，建议先补上（否则 Release 说明只含安装包列表）")
    if MANIFEST.exists():
        mc = re.search(r"(?m)^changelog=(.*)$", MANIFEST.read_text(encoding="utf-8"))
        if mc and not mc.group(1).strip().startswith(ver):
            print(f"[提示] manifest 的 changelog= 仍是旧版本：{mc.group(1).strip()[:20]}…，建议同步为 v{ver} 的说明")

    r = subprocess.run(["git", "status", "--porcelain"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.stdout.strip():
        print("[提示] 存在未提交改动，建议先运行 push.py 再发布（不阻断）")

    if not build_all(ver):
        return 1
    tag_ok = push_tag(ver)
    rel_rc = github_release(ver)

    print("")
    print("============== 发布结果 ==============")
    if rel_rc == 0:
        print(f"[成功] v{ver} 发布完成：标签 + Release + 全平台安装包均已就绪")
        nv = bump_version(ver)
        finalize_changelog(ver, nv)                 # 更新日志标日期 + 预留下一版本
        if nv:
            commit_bump(nv)
            print("[提示] 下次发布将默认使用 v" + nv + "；发布前可顺手更新 manifest 的 changelog=")
    else:
        print("[未完成] 仅完成本地构建；标签 " + ("已推送" if tag_ok else "未推送成功"))
        print("        Release 未创建，见上方说明")
    print("=======================================")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
