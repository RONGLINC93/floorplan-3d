# floorplan-3d 项目长期约定

## 3D 交互统一规范（对齐门 / 窗 / 灯具 / 旗杆的成熟做法）

四种场景必须逐一覆盖，不能只做设计态：

1. **设计态（orbit）**：交互型构件点击 = 动作 + `window.select`（面板打开）；选中 → `updateSel()` 橙色 BoxHelper；「移动」工具可拖动（`objdrag`）；悬停 = `doorHi` 高亮 + `doorTip` 气泡。
2. **预览态（m3dPreview）**：只动作不选中，不显示选中包围盒（`updateSel` 抑制）。
3. **漫游态（walk）**：点击 / E 只动作不选中；瞄准 = `doorHiRef` 高亮 + `walkTip`；距离门限：门 / 室内灯 2.5m，路灯类 3.5m；不显示选中框。
4. **pick3d 约定**：`{ kind, id }`；同集合区分动作用 `e.type` 作 kind（如 streetlamp / solarlamp），但选中记为 `{ kind: 'extra' }` → `updateSel` 与 `objdrag` 要做 lampKind 映射，否则选中框 / 拖动失效。高亮 Box3 排除光晕 Sprite。

详细版在 `.codebuddy/rules/floorplan-3d/RULE.mdc`「3D 交互统一规范」一节，以该文件为准。

## 其它踩坑备忘

- 点式扩展构件放置：`onSvgPointerDown` 大数组白名单 + 点式放置分支两处都要加新类型，漏一处就"画不出来"。
- 2D 扩展构件实际渲染容器是 `#gNotes`（不是 `#gExtras`）。
- 室内太阳能热水器类型叫 `solar`，路灯别占用这个名字；室内灯具 `LAMP_TYPES` 与路灯 `STREET_LAMP_TYPES` 不能重名。
- 蓄能 / 电量等每 0.5s 变化的字段：只 `markDirty()` 不入撤销栈，否则撤销记录被刷爆。
- `applyLight()` 统一控制所有自发光 / 点光源 / 光晕 / 光斑；新灯型挂 `lampGlowMats` + `userData.lampRef` 接入即可。
