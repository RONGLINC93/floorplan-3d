# floorplan-3d 项目长期约定

## 3D 交互统一规范（对齐门 / 窗 / 灯具 / 旗杆的成熟做法）

四种场景必须逐一覆盖，不能只做设计态：

1. **设计态（orbit）**：交互型构件点击 = 动作 + `window.select`（面板打开）；选中 → `updateSel()` 橙色 BoxHelper；「移动」工具可拖动（`objdrag`）；悬停 = `doorHi` 高亮 + `doorTip` 气泡。
2. **预览态（m3dPreview）**：只动作不选中，不显示选中包围盒（`updateSel` 抑制）。
3. **漫游态（walk）**：点击 / E 只动作不选中；瞄准 = `doorHiRef` 高亮 + `walkTip`；距离门限：门 / 室内灯 2.5m，路灯类 3.5m；不显示选中框。
4. **pick3d 约定**：`{ kind, id }`；同集合区分动作用 `e.type` 作 kind（如 streetlamp / solarlamp），但选中记为 `{ kind: 'extra' }` → `updateSel` 与 `objdrag` 要做 lampKind 映射，否则选中框 / 拖动失效。高亮 Box3 排除光晕 Sprite。

详细版在 `.codebuddy/rules/floorplan-3d/RULE.mdc`「3D 交互统一规范」一节，以该文件为准。

## 版本约定（不写死）
- 当前版本以**实时读取**为准：`CHANGELOG.md` 顶部小节（标题带日期 = 已发布，带「（开发中）」= 可追加条目）+ `manifest` 的 `version=` 字段 + 页面 `APP_VER` 三者保持一致。记忆/日志里写死的版本号只是快照，一律不作为依据。
- 新条目只写进顶部「（开发中）」小节；功能默认值类算「新增」，行为纠错类算「修复」。

## 其它踩坑备忘

- 点式扩展构件放置：`DRAW_PLACE_TOOLS`（Set 常量，原 onSvgPointerDown 内联 130 项数组）+ 点式放置分支两处都要加新类型，漏一处就"画不出来"。
- **状态改动与 3D 刷新契约**：`View3D.sync()` 用 `window.stateRev` 版本号判断是否重算签名，凡是改变 `state` 的入口（`mutate` / `commit` / `undo` / `redo` 均已递增）必须走 `commit`，直接改 `state` 又期望 3D 刷新会失效。电量 / 信号相位这类每 0.5s 的字段刻意不 bump（视觉由 `applyLight` / `updateSolarVisuals` 直改）。
- 2D 扩展构件实际渲染容器是 `#gNotes`（不是 `#gExtras`）；电梯 / 灯具 / 电箱的 2D 符号却画在 `gOpens`（`renderOpenings` 里的 renderLifts2 / renderLamps2 / renderBoxes2）。
- 室内太阳能热水器类型叫 `solar`，路灯别占用这个名字；室内灯具 `LAMP_TYPES` 与路灯 `STREET_LAMP_TYPES` 不能重名。
- 蓄能 / 电量等每 0.5s 变化的字段：只 `markDirty()` 不入撤销栈，否则撤销记录被刷爆。
- `applyLight()` 统一控制所有自发光 / 点光源 / 光晕 / 光斑；新灯型挂 `lampGlowMats` + `userData.lampRef` 接入即可。
- **验证纪律**：改 `index.html` 后必须 grep 复核（曾有外部编辑器并发覆盖、静默回退改动的情况）；浏览器冒烟测试必须 `python app.py --data-dir <临时目录>`，否则防抖自动保存会覆盖 `plans/` 里的真实方案。
