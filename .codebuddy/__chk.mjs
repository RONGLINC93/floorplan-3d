
    /* ============================================================
     *  3D 场景（three.js）—— 与 2D 共用 state / ui，切换时带过渡动画：
     *  2D → 3D：3D 相机先以正俯视对齐当前 2D 视口（比例、位置一致），
     *           交叉淡入后镜头倾斜环绕、墙体从地面升起、家具随后立起；
     *  3D → 2D：反向——家具收起、墙体下沉、镜头回到正俯视并淡出到平面图。
     * ============================================================ */
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
    import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
    import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
    import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

    const stage = $('#stage'), host = $('#view3d');
    const OX = 6000, OY = 5300, FOV = 45, FULL_CUT = 2.8; // 户型中心放在世界原点
    let H = 2.8;                                          // 当前楼层高度（米）：按楼层设置，buildArch 前更新
    let stackSkipSlabs = new Set();                       // 整栋模式跨层楼板去重：被上层地板盖住的层顶板 id（或反向），buildSlab3D 据此跳过，单层模式为空
    const BAY_DRIP = .06;                                // 飘窗顶板 / 窗台板外挑（挡雨滴水檐，上下同尺寸才齐平）
    const wx = x => (x - OX) / 1000, wz = y => (y - OY) / 1000, M = v => v / 1000;
    const SW = () => stage.clientWidth, SH = () => stage.clientHeight;
    const opt = { cut: 2.8, full: true, furn: true, labels: true, slabs: true, hi: true, allFloors: false, night: false, hour: 10, mode: 'orbit' };

    let inited = false, active = false, raf = 0, anim = null, fly = null;
    let renderer, labelRenderer, scene, camera, orbit, walkCtl, hemi, sun, ground, glassMat, wallMat, capMat, frameMat, casingMat, steelMat, entryCasingMat;
    let archFloor, archUp, furnG, labelG, lampG, colliders = [], barriers = [], sills = [], revolveSpins = [], revolveHit = [], escSteps = [], furnCols = [], selKey = null, selHelpers = [], lampGlowMats = [];   // sills：电梯门抬高门槛的可踩踏台面（不挡人）；barriers：扶手/围栏的带高度线段碰撞（漫游挡人）；revolveSpins：旋转门旋翼组（主循环持续转动）；revolveHit：旋转门三翼的随动线段碰撞数据；escSteps：自动扶梯梯级组（主循环沿斜坡循环平移）；furnCols：家具外接盒碰撞（buildFurn 独立重建，与 colliders 清空时机解耦）；lampGlowMats：自建灯具的发光材质（applyLight 按夜景与开关状态统一点亮）
    let floorGroup = null;                                // 当前（激活）楼层组容器：整栋按层堆叠，漫游 / 拾取只针对激活层
    const floorY = () => { const f = (state.floors || []).find(x => x.id === state.activeFloor); return f ? f.z / 1000 : 0; };   // 当前层基准标高（米）
    let sigArch = '', sigFurn = '', sigLabels = '', sigStack = '', grow = 1, furnGrow = 1;
    let floorWorlds = [], extraGroups = [], skipLift3D = false;   // 全楼层漫游：其它楼层的完整几何 / 碰撞数据，以及是否跳过重复轿厢
    let activeDoors = [], activeLampGlowMats = [], activeEscSteps = [], activeRevolveSpins = [];   // 当前层的门 / 灯 / 动画对象（不含其它楼层合并进来的对象）
    const normColsY = (arr, top) => (arr || []).map(c => { const n = c.length >= 6 ? c.slice() : [c[0], c[1], c[2], c[3], 0, top]; if (c.carId != null) n.carId = c.carId; return n; });   // 4 元素旧式碰撞（墙等）补 y 区间 0~top（本层局部高度），防止跨层串挡；保留整车碰撞的 carId（驾驶时跳过本车）
    let primaryCols = null;                                       // 整栋模式下当前层碰撞的 0~层高规范化副本；null = 单层模式直接用 colliders
    let primaryFP = null;                                         // 当前层足迹缓存：{ rooms:[多边形], rects:[地板 / 阳台 AABB] }（世界米）
    let stackDefaultFloors = false;                               // 整栋模式构建其它楼层时置真：无样式房间也按默认材质生成楼板 / 天花，上层仰视不再是空的
    /* 安防监控 3D 实时取景：
       survRigs  = 每台摄像头的离屏相机 + WebGLRenderTarget（从摄像头真实视角渲染场景）
       survScreens = 每台显示器的离屏 canvas + CanvasTexture（把各路取景拼成带 OSD 的画面贴到屏幕）
       survScreenMeshes = 所有屏幕面网格，离屏取景时临时隐藏，避免摄像机拍到屏幕形成反馈
       buildArch 重建时统一 dispose / 清空。 */
    let survRigs = [], survScreens = [], survScreenMeshes = [], survTexs = [];
    const survT = { last: 0, noise: null };                       // 取景节流时间戳 + 无信号雪花纹理缓存
    const pointInPoly = (x, z, poly) => {                         // 射线法：点是否在多边形内（世界米）
      let ins = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
        if (((zi > z) !== (zj > z)) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins;
      }
      return ins;
    };
    function fpRooms() { return allRooms().filter(r => r.poly && r.poly.length >= 3).map(r => r.poly.map(p => [wx(p[0]), wz(p[1])])); }   // 全部房间多边形（含 bover 覆盖与自画房间）→ 世界米
    function fpRects() {                                          // 地板区域（世界米 AABB）：底标高 0 的整层楼面；抬高 >200mm 的板是挑板 / 雨棚，不算可站立楼面
      const out = [];
      (state.slabs || []).forEach(s => { if (!s.farea || Math.abs(+s.z || 0) > 200) return; const w = Math.max(.1, (s.w || 0) / 1000) / 2, d = Math.max(.1, (s.d || 0) / 1000) / 2; out.push([wx(s.x) - w, wz(s.y) - d, wx(s.x) + w, wz(s.y) + d]); });
      return out;
    }
    function fpTopRects() {                                       // 层顶楼板区域（世界米 AABB）：顶面与本层层高齐平，整栋漫游踩在层顶时由它提供支撑
      const out = [];
      (state.slabs || []).forEach(s => { if (!s.top) return; const w = Math.max(.1, (s.w || 0) / 1000) / 2, d = Math.max(.1, (s.d || 0) / 1000) / 2; out.push([wx(s.x) - w, wz(s.y) - d, wx(s.x) + w, wz(s.y) + d]); });
      return out;
    }
    function fpBalconies() {                                      // 阳台挑板占地区域（世界米 AABB）：阳台本身也是楼面的一部分
      const out = [];
      (state.balconies || []).forEach(b => { const w = Math.max(.3, (b.w || 0) / 1000) / 2, d = Math.max(.3, (b.d || 0) / 1000) / 2; out.push([wx(b.x) - w, wz(b.y) - d, wx(b.x) + w, wz(b.y) + d]); });
      return out;
    }
    function fpHoles() {                                          // 板面开洞区域（世界米 AABB）：手画「楼梯间 / 电梯井」与「楼板洞口」穿过地板 / 层顶楼板处都镂空
      const out = [];
      (state.slabs || []).forEach(s => {
        if (!s.well) return;
        const w = Math.max(.1, (s.w || 0) / 1000) / 2, d = Math.max(.1, (s.d || 0) / 1000) / 2;
        out.push([wx(s.x) - w, wz(s.y) - d, wx(s.x) + w, wz(s.y) + d]);
      });
      (state.extras || []).forEach(e => {
        if (e.type !== 'slabhole') return;
        const w = Math.max(.1, (e.w || 0) / 1000) / 2, d = Math.max(.1, (e.d || 0) / 1000) / 2;
        out.push([wx(e.x) - w, wz(e.y) - d, wx(e.x) + w, wz(e.y) + d]);
      });
      return out;
    }
    function fpOf() { return { rooms: fpRooms(), rects: fpRects(), topRects: fpTopRects(), balc: fpBalconies(), holes: fpHoles() }; }
    function isGroundFloor(id) {                                  // 是否底层（z 最小的楼层）：底层地面整片可走（户外草地），上层只在建筑足迹内可走
      const fs = state.floors || [], f = fs.find(x => x.id === id);
      return !f || (f.z || 0) <= Math.min(...fs.map(x => x.z || 0)) + 1e-6;
    }
    const doors = [], gateArms = [], keys = {};   // gateArms：道闸机闸杆动画态（id/open/cur/a0/a1/pivot），loop 里插值 rotation.z
    const parkAnims = [], parkLamps = new Map();  // 停车场配套：parkAnims 升降柱 / 伸缩门的动画态（open/cur/apply），parkLamps 车位灯 / 充电桩灯（id → mesh）
    const stackCells = new Map(), stackOps = [];  // 立体车库：stackCells 每格载车板（id_层_列 → {g,baseY,drop,cw,dep,car,target}），stackOps 单次升降取存车动画
    const sanVisuals = new Map();                 // 环卫配套 12 件：id → { lamps, doors, water, binAnims, cpAnims, portAnims }，按 on / binOpen / cpOpen / ports 状态统一刷新
    const wtVisuals = new Map(), wtRuns = [];     // 垃圾转运站：id → { lamps, lids, mists, runs }；wtRuns 压缩机推杆等运行动画（loop 里每帧驱动）
    const washVisuals = new Map(), washRuns = new Map();   // 自动洗车机：id → 机体网格集；washRuns 进行中的洗车流程（start 时刻，loop 里按时间轴驱动）

    function startWash(id, durS) {                // 登记一次洗车流程（时长 e.dur 秒，默认 14），重建场景后按方案 busy 状态续播
      const k = String(id);
      if (!washRuns.has(k)) washRuns.set(k, { start: performance.now(), dur: Math.max(8, (+durS || 14)) * 1000 });
    }
    function carWashStep(now, dt) {               // 洗车时间轴（龙门自己走完全程，无示范车）：预湿(0-.18) → 泡沫(.18-.36) → 正刷(.36-.57) → 回刷(.57-.79) → 冲净(.79-.89) → 风干回位(.89-1)，按清洗时长等比缩放
      washRuns.forEach((run, id) => {
        const sv = washVisuals.get(id);
        if (!sv || !sv.gantry) {                             // 场景重建 / 构件刚删：保留流程等下一帧，别把 busy 卡死
          const e2 = (state.extras || []).find(x => String(x.id) === String(id));
          if (!e2 || e2.busy !== true) washRuns.delete(id);
          return;
        }
        const W = sv.W, home = -W / 2 + .9, p1 = W * .3, p2 = -W * .2, u = Math.min(1, (now - run.start) / run.dur);   // u = 归一化进度 0→1
        const a = .18, b = .36, c = .57, d2 = .79, e1 = .89;               // 各阶段分界（14 秒基准等比）
        const seg = (x0, x1) => Math.min(1, Math.max(0, (u - x0) / (x1 - x0))), lp = (x0, x1, s0, s1) => s0 + (s1 - s0) * seg(x0, x1);
        sv.gantry.position.x = u < a ? lp(0, a, home, 0)
          : u < b ? lp(a, b, 0, p1)
          : u < c ? lp(b, c, p1, p2)
          : u < d2 ? lp(c, d2, p2, p1)
          : u < e1 ? lp(d2, e1, p1, 0)
          : lp(e1, 1, 0, home);
        sv.sprayCones.visible = u < a || (u >= d2 && u < e1);   // 只显隐水帘 / 泡沫 / 气流，喷头与风道常驻
        sv.foamCones.visible = u >= a && u < b;
        sv.wet.visible = u < 1;
        sv.blowCones.visible = u >= e1 && u < 1;
        const spin = u >= b && u < d2;
        (sv.brushes || []).forEach(bb => { bb.rotation.y += dt * (spin ? (bb.userData.top ? 12 : 9) : 0); });
        if (sv.lamp?.material?.color) sv.lamp.material.color.setHex(Math.sin(now * .012) > 0 ? 0x3f8fe0 : 0x9cc8ee);   // 洗车中蓝灯闪烁
        if (u >= 1) {
          sv.sprayCones.visible = sv.foamCones.visible = sv.wet.visible = sv.blowCones.visible = false;
          sv.gantry.position.x = home;
          washRuns.delete(id);
          const e2 = (state.extras || []).find(x => String(x.id) === String(id));
          if (e2) { e2.busy = false; applyParkVisual(id); markDirty(); if (typeof renderExtras2 === 'function') renderExtras2(); }
          toast(tr('自动洗车机：洗车完成 · 龙门已回位', 'Car wash: done · gantry parked'));
        }
      });
    }
    const sanBinStates = e => Array.isArray(e?.binOpen) && e.binOpen.length === 4 ? e.binOpen : [e?.on === true, e?.on === true, e?.on === true, e?.on === true];   // 分类垃圾桶四桶状态；旧方案无 binOpen 时按 on 全部展开
    const cpBinStates = (e, n) => Array.isArray(e?.cpOpen) && e.cpOpen.length === n ? e.cpOpen : new Array(n).fill(false);   // 垃圾收集点各桶盖状态（桶数随宽度变）；旧方案无 cpOpen 时全合盖
    const BIN_SIGN_TEX = new Map();                  // 垃圾桶桶身图标贴图缓存（四分类 + 果皮箱，五张复用）
    function binSignTexture(i) {                     // 简笔图标 + 中文：0 可回收 / 1 有害 / 2 厨余 / 3 其他 / 4 果皮箱
      if (BIN_SIGN_TEX.has(i)) return BIN_SIGN_TEX.get(i);
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 320;
      const g = cv.getContext('2d'), C = ['#2f7fd0', '#cf4b42', '#3f9d5c', '#8a9299', '#7b878f'][i];
      g.fillStyle = '#f7f8f6'; g.fillRect(8, 8, 240, 304);
      g.strokeStyle = C; g.lineWidth = 10; g.strokeRect(13, 13, 230, 294);
      g.save(); g.translate(128, 132); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = C; g.fillStyle = C;
      if (i === 0) {                                 // 可回收物：三箭头循环三角
        g.lineWidth = 15;
        for (let k = 0; k < 3; k++) { g.save(); g.rotate(k * Math.PI * 2 / 3);
          g.beginPath(); g.moveTo(-26, -26); g.lineTo(0, -62); g.lineTo(26, -26); g.stroke();
          g.beginPath(); g.moveTo(0, -68); g.lineTo(20, -56); g.lineTo(-20, -56); g.closePath(); g.fill(); g.restore(); }
      } else if (i === 1) {                          // 有害垃圾：叉号
        g.lineWidth = 20; g.beginPath(); g.moveTo(-44, -44); g.lineTo(44, 44); g.moveTo(44, -44); g.lineTo(-44, 44); g.stroke();
        g.beginPath(); g.arc(0, 0, 13, 0, Math.PI * 2); g.fill();
      } else if (i === 2) {                          // 厨余垃圾：鱼骨
        g.lineWidth = 10; g.beginPath(); g.moveTo(-50, 0); g.lineTo(36, 0); g.stroke();
        g.beginPath(); g.arc(-52, 0, 15, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(36, 0); g.lineTo(60, -22); g.lineTo(60, 22); g.closePath(); g.fill();
        [-28, -8, 12].forEach(x => { g.lineWidth = 7; g.beginPath(); g.moveTo(x, 0); g.lineTo(x - 10, -22); g.moveTo(x, 0); g.lineTo(x - 10, 22); g.stroke(); });
      } else if (i === 3) {                          // 其他垃圾：垃圾桶 + 向下箭头
        g.lineWidth = 11; g.strokeRect(-42, -14, 84, 66);
        g.beginPath(); g.moveTo(-52, -14); g.lineTo(52, -14); g.moveTo(-14, -28); g.lineTo(14, -28); g.stroke();
        g.beginPath(); g.moveTo(0, -56); g.lineTo(0, 10); g.moveTo(-17, -7); g.lineTo(0, 10); g.lineTo(17, -7); g.stroke();
      } else {                                       // 果皮箱：果皮（苹果核）+ 叶片
        g.lineWidth = 11;
        g.beginPath(); g.moveTo(-30, -46); g.quadraticCurveTo(-40, 30, -10, 48); g.moveTo(30, -46); g.quadraticCurveTo(40, 30, 10, 48); g.stroke();
        g.beginPath(); g.moveTo(-16, -48); g.quadraticCurveTo(0, -60, 16, -48); g.stroke();
        g.beginPath(); g.moveTo(2, -52); g.quadraticCurveTo(30, -74, 40, -46); g.quadraticCurveTo(18, -44, 2, -52); g.fill();
      }
      g.restore();
      g.fillStyle = C; g.font = 'bold 40px "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(['可回收物', '有害垃圾', '厨余垃圾', '其他垃圾', '果皮箱'][i], 128, 270);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      BIN_SIGN_TEX.set(i, tex); return tex;
    }
    const sanPortStates = e => Array.isArray(e?.ports) && e.ports.length === 3 ? e.ports : [e?.on === true, e?.on === true, e?.on === true];   // 回收站三投放口状态；旧方案无 ports 时按 on 全部打开
    const SAN_TOAST = {                           // 环卫配套：各件开(on)/关(off)状态提示，顺序 [中开, 中关, 英开, 英关]
      sanSortBin:[ '分类垃圾桶：桶盖已打开', '分类垃圾桶：桶盖已合上', 'Sorting bin: lids opened', 'Sorting bin: lids closed' ],
      sanLitterBin:[ '果皮箱：已开盖', '果皮箱：已合盖', 'Litter bin: lid opened', 'Litter bin: lid closed' ],
      sanCollectPoint:[ '垃圾收集点：已清运 · 绿灯', '垃圾收集点：待清运 · 红灯', 'Collection point: emptied · green', 'Collection point: full · red' ],
      sanGarbageRoom:[ '垃圾房：门已打开', '垃圾房：门已关闭', 'Garbage room: door opened', 'Garbage room: door closed' ],
      sanToilet:[ '公共厕所：有人 · 红灯', '公共厕所：无人 · 绿灯', 'Public toilet: occupied · red', 'Public toilet: vacant · green' ],
      sanMobileToilet:[ '移动厕所：有人 · 红灯', '移动厕所：无人 · 绿灯', 'Portable toilet: occupied · red', 'Portable toilet: vacant · green' ],
      sanWashBasin:[ '洗手台：已出水', '洗手台：已停水', 'Wash basin: water on', 'Wash basin: water off' ],
      sanToolCabinet:[ '环卫工具柜：门已打开', '环卫工具柜：门已关闭', 'Tool cabinet: door opened', 'Tool cabinet: door closed' ],
      sanWaterPoint:[ '洒水取水点：已出水', '洒水取水点：已停水', 'Water point: water on', 'Water point: water off' ],
      sanTransferStation:[ '垃圾转运站：压缩中 · 绿灯', '垃圾转运站：待机 · 黄灯', 'Transfer station: compacting · green', 'Transfer station: standby · amber' ],
      sanRecycleStation:[ '再生资源回收站：门已打开', '再生资源回收站：门已关闭', 'Recycling station: door opened', 'Recycling station: door closed' ],
      sanRestRoom:[ '环卫休息室：灯已打开', '环卫休息室：灯已关闭', 'Rest room: light on', 'Rest room: light off' ]
    };
    const WT_TOAST = {                            // 垃圾转运站：各件开(on)/关(off)状态提示，顺序 [中开, 中关, 英开, 英关]
      wtStation:[ '转运车间：卷帘门已打开', '转运车间：卷帘门已关闭', 'Transfer hall: door opened', 'Transfer hall: door closed' ],
      wtCompactor:[ '垃圾压缩机：已启动 · 运行中', '垃圾压缩机：已停止', 'Compactor: running', 'Compactor: stopped' ],
      wtBox:[ '勾臂转运箱：箱盖已打开', '勾臂转运箱：箱盖已合上', 'Container: lid opened', 'Container: lid closed' ],
      wtMist:[ '除臭喷淋：已开启 · 喷雾中', '除臭喷淋：已关闭', 'Misting: on', 'Misting: off' ]
    };

    /* ======================= 初始化 ======================= */
    function init() {
      if (inited) return; inited = true;
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(SW(), SH());
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
      host.prepend(renderer.domElement);
      renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());   // 3D 里右键是平移，禁掉浏览器菜单
      labelRenderer = new CSS2DRenderer();
      labelRenderer.setSize(SW(), SH());
      Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
      host.appendChild(labelRenderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(FOV, SW() / SH(), .05, 300);
      orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = true; orbit.maxPolarAngle = Math.PI * .495; orbit.minDistance = 1.5; orbit.maxDistance = 45;
      orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };   // 中键（滚轮键）拖动平移
      walkCtl = new PointerLockControls(camera, document.body);
      walkCtl.addEventListener('lock', () => { $('#walkOverlay').style.display = 'none'; $('#cross').style.display = 'block'; });
      walkCtl.addEventListener('unlock', () => { if (opt.mode === 'walk') { $('#walkOverlay').style.display = 'flex'; $('#cross').style.display = 'none'; } });

      hemi = new THREE.HemisphereLight(0xfff8ee, 0xb9a88f, 1.1);
      sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
      sun.castShadow = true; sun.shadow.mapSize.setScalar(COARSE ? 2048 : 4096);   // 平板 GPU 用小一点的阴影贴图
      Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 60 });
      sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
      ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0xf2eee7, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2; ground.position.y = -0.015; ground.receiveShadow = true;
      scene.add(hemi, sun, sun.target, ground);

      const pm = new THREE.PMREMGenerator(renderer); envTex = pm.fromScene(new RoomEnvironment(), .04).texture; pm.dispose();
      glassMat = new THREE.MeshPhysicalMaterial({ color: 0xcfe6ef, roughness: .05, transparent: true, opacity: .28, depthWrite: false, side: THREE.DoubleSide });
      wallMat = mat('#f4f1eb', { roughness: .92 }); capMat = mat('#34312d', { roughness: .9 }); frameMat = mat('#5d6166', { roughness: .5, metalness: .4 });
      casingMat = mat('#eae1d2', { roughness: .68 });   // 门套：浅色木饰面，避免深色金属框显得突兀
      steelMat = mat('#c9ced3', { metalness: .92, roughness: .22 });   // 不锈钢门扇 / 门套
      entryCasingMat = mat('#6b4f3a', { roughness: .5 });              // 入户门套：与入户门扇同色

      floorGroup = new THREE.Group(); scene.add(floorGroup);   // 当前层的全部建筑 / 家具 / 标签都在该组内，随层标高整体上移
      archFloor = new THREE.Group(); archUp = new THREE.Group(); furnG = new THREE.Group(); labelG = new THREE.Group(); lampG = new THREE.Group();
      floorGroup.add(archFloor, archUp, furnG, labelG, lampG);

      const cv = renderer.domElement; let downAt = null, look = null;
      cv.addEventListener('pointerdown', e => {
        downAt = [e.clientX, e.clientY]; window.closeDrawers();
        if (touchWalk && !look) { look = { id: e.pointerId, x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); }
      });
      cv.addEventListener('pointermove', e => {
        if (!look || e.pointerId !== look.id) return;
        lookBy(e.clientX - look.x, e.clientY - look.y); look.x = e.clientX; look.y = e.clientY;
      });
      cv.addEventListener('pointercancel', e => { if (look?.id === e.pointerId) look = null; });

      // 按住已选中的家具拖动：沿地面摆放（与 2D 共用网格和贴墙吸附）。
      // 在父元素上用捕获阶段监听，赶在 OrbitControls 之前关掉它，避免同时旋转镜头
      let fdrag = null, objdrag = null;
      const OBJ_ARRS = {
        wall: 'walls', arcwall: 'arcWalls', pillar: 'pillars', stair: 'stairs', lift: 'lifts', rail: 'rails', beam: 'beams', slab: 'slabs', parapet: 'parapets',
        canopy: 'canopies', balcony: 'balconies', planter: 'planters', flue: 'flues', extra: 'extras', roof: 'roofs', pergola: 'pergolas', deck: 'decks', pool: 'pools', gate: 'gates', lamp: 'lamps', pbox: 'powerBoxes', wbox: 'weakBoxes'
      };
      const find3dObj = (kind, id) => {
        if (kind === 'wall' || kind === 'arcwall') {                 // 原始墙（wN）固定在户型里，不可拖动
          const pre = kind === 'wall' ? 'CW' : 'AW', arr = state[kind === 'wall' ? 'walls' : 'arcWalls'] || [];
          return String(id).startsWith(pre) ? arr.find(o => pre + o.id === id) : null;
        }
        const arr = state[OBJ_ARRS[kind]];
        return arr ? arr.find(o => String(o.id) === String(id)) : null;
      };
      const openDragInfo = (kind, id) => {                          // 门窗只能沿依附的墙滑动（与 2D 规则一致）
        if (kind === 'open') {
          const o = (state.openings || []).find(x => x.id === id);
          if (!o || o.legs) return null;                             // 转角飘窗的折线腿不做整体拖动
          const g = openingWallGeom(o.wall); if (!g) return null;
          return { custom: true, o, axis: g.u, c0: o.c, min: 0, max: Math.max(0, g.L - o.w) };
        }
        if (kind === 'lamp') {                                       // 壁装灯具：沿依附的墙滑动（与 2D 规则一致）
          const l = (state.lamps || []).find(x => x.id === id);
          if (!l || !l.wall) return null;                            // 吸顶 / 吊灯等仍走整体平移
          const g = openingWallGeom(l.wall); if (!g) return null;
          return { custom: true, lampObj: l, axis: g.u, c0: l.c ?? 0, min: 0, max: g.L };
        }
        if (BOX_ARR[kind]) {                                         // 电箱：沿依附的墙滑动，不脱离墙体
          const b = (state[BOX_ARR[kind]] || []).find(x => x.id === id);
          if (!b || !b.wall) return null;
          const g = openingWallGeom(b.wall); if (!g) return null;
          return { custom: true, boxObj: b, axis: g.u, c0: b.c ?? 0, min: 0, max: g.L };
        }
        if (kind === 'bopen') {
          const r = bopenRect(id); if (!r) return null;
          const hz = LONG(r);
          return { custom: false, id, hz, axis: hz ? [1, 0] : [0, 1], d0: [...(bov(id).d || [0, 0])] };
        }
        return null;
      };
      const move3dObj = (o, dx, dy) => {                            // 点构件改 x/y，线构件（墙 / 梁 / 栏杆等）平移两端点
        if (o.a && o.b) { o.a[0] += dx; o.a[1] += dy; o.b[0] += dx; o.b[1] += dy; }
        else if (typeof o.x === 'number' && typeof o.y === 'number') { o.x += dx; o.y += dy; }
      };
      host.addEventListener('pointerdown', e => {
        if (e.target !== cv || !e.isPrimary || anim || opt.mode !== 'orbit' || m3dPreview || !ui.sel || (ui.tool === 'draw' && ui.drawTool !== 'move')) return;   // 仅「移动」工具可按住已选对象拖动（硬性约定：选择只选中 / 改尺寸），其余交给镜头旋转
        const h = pick(e), g = groundAt(e.clientX, e.clientY);
        if (!g) return;
        if (ui.sel.kind === 'furn') {
          const f = h?.fid === ui.sel.id && getF(h.fid);
          if (!f) return;
          fdrag = { id: f.id, pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: g.x - f.cx, oy: g.y - f.cy, before: snap(), moved: false };
        } else {
          const lampPick = (h?.kind === 'streetlamp' || h?.kind === 'solarlamp' || h?.kind === 'traflight' || h?.kind === 'facLaneLight') && ui.sel.kind === 'extra';   // 路灯 / 太阳能路灯 / 信号灯 / 车道灯：pick3d 用 type 作 kind，选中记为 extra，这里对齐后按 extra 拖动
          if (!h?.kind || String(h.id) !== String(ui.sel.id) || (h.kind !== ui.sel.kind && !lampPick)) return;
          const dkind = lampPick ? 'extra' : h.kind;
          const info = openDragInfo(dkind, h.id);
          if (!info && !find3dObj(dkind, h.id)) return;
          objdrag = {
            kind: dkind, id: h.id, pid: e.pointerId, sx: e.clientX, sy: e.clientY, gx: g.x, gy: g.y, dx: 0, dy: 0, moved: false, openInfo: info,
            targets: archUp.children.filter(o => {
              const t = o.userData.pick3d; if (!t || String(t.id) !== String(h.id)) return false;
              return t.kind === h.kind || (lampPick && (t.kind === 'streetlamp' || t.kind === 'solarlamp' || t.kind === 'traflight' || t.kind === 'facLaneLight'));
            }).map(o => ({ o, x: o.position.x, z: o.position.z }))
          };
        }
        orbit.enabled = false; fly = null; cv.setPointerCapture(e.pointerId);
      }, true);
      cv.addEventListener('pointermove', e => {
        if (objdrag && e.pointerId === objdrag.pid) {
          if (!objdrag.moved && Math.hypot(e.clientX - objdrag.sx, e.clientY - objdrag.sy) < TAP) return;
          const g = groundAt(e.clientX, e.clientY); if (!g) return;
          objdrag.moved = true; cv.style.cursor = 'move';
          const step = e.shiftKey ? 50 : 10, info = objdrag.openInfo;
          if (info) {                                                // 门窗：沿墙投影，改中心位置 / 原始门窗偏移
            const t = Math.round(((g.x - objdrag.gx) * info.axis[0] + (g.y - objdrag.gy) * info.axis[1]) / step) * step;
            if (info.custom) {
              const nc = Math.max(info.min, Math.min(info.max, Math.round((info.c0 + t) / step) * step));
              if (info.o && (state.openings || []).some(q => q.wall === info.o.wall && q.id !== info.o.id && nc < q.c + q.w && q.c < nc + info.o.w)) return;   // 与其它门窗重叠 → 不动
              objdrag.newC = nc; objdrag.dx = (nc - info.c0) * info.axis[0]; objdrag.dy = (nc - info.c0) * info.axis[1];
            } else {
              objdrag.newD = info.hz ? [info.d0[0] + t, info.d0[1]] : [info.d0[0], info.d0[1] + t];
              objdrag.dx = objdrag.newD[0] - info.d0[0]; objdrag.dy = objdrag.newD[1] - info.d0[1];
            }
          } else {
            objdrag.dx = Math.round((g.x - objdrag.gx) / step) * step;
            objdrag.dy = Math.round((g.y - objdrag.gy) / step) * step;
          }
          objdrag.targets.forEach(t => { t.o.position.x = t.x + objdrag.dx / 1000; t.o.position.z = t.z + objdrag.dy / 1000; });   // 先挪模型，松手写回方案
          return;
        }
        if (!fdrag || e.pointerId !== fdrag.pid) return;
        if (!fdrag.moved && Math.hypot(e.clientX - fdrag.sx, e.clientY - fdrag.sy) < TAP) return;
        const f = getF(fdrag.id), g = groundAt(e.clientX, e.clientY); if (!f || !g) return;
        fdrag.moved = true; cv.style.cursor = 'move';
        [f.cx, f.cy] = snapMove(f, g.x - fdrag.ox, g.y - fdrag.oy);
        furnG.children.find(o => o.userData.fid === f.id)?.position.set(wx(f.cx), 0, wz(f.cy));   // 拖动中只挪模型，松手再整体同步
      });
      const endF = e => {
        if (e.type === 'pointerup' && e.button !== 0) return;          // 右键 / 中键松手不当作点击（右键另有平移 / 取消绘制）
        if (objdrag && e.pointerId === objdrag.pid) {
          const d = objdrag; objdrag = null; orbit.enabled = true; cv.style.cursor = cursorForTool();
          const info = d.openInfo;
          let ok = false;
          if (d.moved && (d.dx || d.dy)) {
            if (info?.lampObj && d.newC != null) { mutate(() => { info.lampObj.c = d.newC; const q = wallLampPos(info.lampObj); if (q) { info.lampObj.x = q.x; info.lampObj.y = q.y; } }); ok = true; }
            else if (info?.boxObj && d.newC != null) { mutate(() => { info.boxObj.c = d.newC; const q = boxWallPos(info.boxObj); if (q) { info.boxObj.x = q.x; info.boxObj.y = q.y; } }); ok = true; }
            else if (info?.custom && d.newC != null) { mutate(() => { info.o.c = d.newC; clampOpening(info.o); }); ok = true; }
            else if (info && d.newD) { mutate(() => { state.bover[d.id] = { ...bov(d.id), d: d.newD }; clampBopen(d.id); }); ok = true; }
            else { const o = find3dObj(d.kind, d.id); if (o) { mutate(() => move3dObj(o, d.dx, d.dy)); ok = true; } }
          }
          if (!ok) d.targets.forEach(t => { t.o.position.x = t.x; t.o.position.z = t.z; });   // 未拖动 / 取消：还原模型位置
          return;
        }
        if (!fdrag || e.pointerId !== fdrag.pid) return;
        const d = fdrag; fdrag = null; orbit.enabled = true; cv.style.cursor = cursorForTool();
        if (d.moved) { commit(d.before); markDirty(); renderAll(); }
      };
      cv.addEventListener('pointerup', endF); cv.addEventListener('pointercancel', endF);
      cv.addEventListener('contextmenu', e => {                    // 3D 绘制态右击：取消起点 / 回到选择，与 2D 一致（仅画布，不挡浏览器其它菜单）
        e.preventDefault();
        if (active && !anim && opt.mode === 'orbit' && !m3dPreview) window.cancelDraw3D?.();
      });

      cv.addEventListener('pointerup', e => {
        if (e.button !== 0) return;                                   // 右键只用于平移 / 取消绘制，不触发插入、开门、关灯等点击行为
        const tap = downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) <= TAP;
        if (look?.id === e.pointerId) {
          look = null;
          if (driveCar) return;                                   // 驾驶中画布点按不触发开门 / 射击（下车用 E / F 或屏幕按钮）
          if (tap) { const h = pick(e); if (h?.liftBtn && h.dist < 3.5) liftBtnAct(h.liftBtn); else if (h?.door && h.dist < 3.5) toggleDoor(h.door); else if (h?.carWin && h.dist < 2.5) toggleDoor(h.carWin); else if (h?.carLamp && h.dist < 3.5) toggleCarLamp(h.carLamp); else if (h?.gateArm && h.dist < 3.5) toggleGateArm(h.gateArm); else if (h?.park && h.dist < 3.5) togglePark(h.park); else if ((h?.flagSel || h?.flagHandle) && h.dist < 3.5) startFlagAnim((state.extras || []).find(x => x.id === (h.flagSel || h.flagHandle))); else if (h?.kind === 'lamp' && h.dist < 2.5) toggleLamp(h.id, h.gang); else if ((h?.kind === 'streetlamp' || h?.kind === 'solarlamp') && h.dist < 3.5) toggleStreetLamp(h.id, false); else if (h?.kind === 'traflight' && h.dist < 3.5) cycleTrafficLight(h.id); else if (h?.kind === 'facLaneLight' && h.dist < 3.5) cycleLaneLight(h.id); else if (carIdFromHit(h) != null && h.dist < 3.5) enterCar(carIdFromHit(h)); else shoot(e); }   // 漫游时点电梯按钮 / 门开关 / 车灯 / 道闸 / 旗杆 / 灯具 / 路灯 / 信号灯 / 车身（上车）；点别处 = 射击
          return;
        }
        if (anim || opt.mode !== 'orbit' || !tap) return;
        if (ui.tool === 'draw' && !m3dPreview && !['select', 'move', 'rotate'].includes(ui.drawTool)) {   // 3D 绘制：地面落点直接复用 2D 建筑工具
          const g = groundAt(e.clientX, e.clientY); if (g) window.drawAt3D?.({ x: g.x, y: g.y }, e.shiftKey);
          return;
        }
        const h = pick(e);
        if (m3dPreview) {                                                 // 3D 预览：门窗可点开合 / 房间可查看，家具不可选编辑
          if (h?.park) togglePark(h.park);                                // 预览态：停车场设备只动作不选中
          else if (h?.gateArm) toggleGateArm(h.gateArm);                   // 预览态：道闸只动作不选中
          else if (h?.carLamp) toggleCarLamp(h.carLamp);                   // 预览态：车灯只动作不选中
          else if (h?.liftBtn) liftBtnAct(h.liftBtn);                     // 预览态也支持电梯楼层 / 开关门按钮
          else if (h?.carWin) toggleDoor(h.carWin);              // 预览态：玻璃升降按钮只动作不选中
          else if (h?.door) { if (h.door.kind === 'car') toggleDoor(h.door); else h.door.open = !h.door.open; }
          else if (h?.flagSel || h?.flagHandle) startFlagAnim((state.extras || []).find(x => x.id === (h.flagSel || h.flagHandle)));
          else if (h?.kind === 'lamp') toggleLamp(h.id, h.gang);
          else if ((h?.kind === 'streetlamp' || h?.kind === 'solarlamp')) toggleStreetLamp(h.id, false);   // 预览态：只开关不选中
          else if (h?.kind === 'traflight') cycleTrafficLight(h.id);   // 预览态：信号灯只切换信号不选中
          else if (h?.kind === 'facLaneLight') cycleLaneLight(h.id);   // 预览态：车道灯只切信号不选中
          else if (h?.room) window.select({ kind: 'room', id: h.room });
          return;
        }
        if (h?.park) togglePark(h.park, true);   // 停车场设备：动作 + 选中
        else if (h?.gateArm) toggleGateArm(h.gateArm, true);   // 道闸机：点击机箱 / 闸杆升降 + 选中
        else if (h?.carLamp) { toggleCarLamp(h.carLamp); window.select({ kind: 'extra', id: h.carLamp }); }   // 车灯：开关 + 选中车辆
        else if (h?.liftBtn) { liftBtnAct(h.liftBtn); window.select({ kind: 'lift', id: h.liftBtn.id }); }   // 呼叫面板按钮：执行后选中电梯（属性面板可继续设置楼层）
        else if (h?.carWin) { toggleDoor(h.carWin); window.select({ kind:'extra', id:h.carWin.carId }); }   // 玻璃升降按钮：降下 / 升起车窗并选中整车
        else if (h?.door) {                                               // 门 / 窗：开合的同时选中它（属性面板可改尺寸 / 材质 / 开启方向）
          if (h.door.kind === 'car') toggleDoor(h.door);                 // 轿车门把手：写回方案（否则重建场景时门会突然弹回关闭）
          else h.door.open = !h.door.open;
          if (BOX_ARR[h.kind] && h.id != null) {                        // 电箱：门状态写回方案，2D 同步显示开启轮廓
            const b = (state[BOX_ARR[h.kind]] || []).find(x => x.id === h.id);
            if (b) { b.doorOpen = h.door.open; renderNotes(); }
          }
          if (h.kind && h.id != null) window.select({ kind: h.kind, id: h.id });
        }
        else if (h?.kind === 'lamp') { toggleLamp(h.id, h.gang); window.select({ kind: 'lamp', id: h.id }); }   // 灯具 / 灯开关：点亮 + 选中（面板可改半径 / 高度）
        else if ((h?.kind === 'streetlamp' || h?.kind === 'solarlamp')) toggleStreetLamp(h.id);   // 路灯：点亮 + 选中（面板可改灯型 / 高度 / 开关）
        else if (h?.kind === 'traflight') cycleTrafficLight(h.id, true);   // 信号灯：切换信号 + 选中（面板可改信号 / 自动轮播）
        else if (h?.kind === 'facLaneLight') cycleLaneLight(h.id, true);   // 车道灯：切红/绿 + 选中
        else if (h?.flagSel || h?.flagHandle) startFlagAnim((state.extras || []).find(x => x.id === (h.flagSel || h.flagHandle)));
        else if (h?.fid) window.select({ kind: 'furn', id: h.fid });
        else if (h?.room) window.select({ kind: 'room', id: h.room });
        else if (h?.kind && h?.id != null) window.select({ kind: h.kind, id: h.id });   // 墙 / 柱 / 楼梯 / 电梯 / 栏杆 / 梁 / 扩展构件等
        else window.select(null);
      });

      // 门交互提醒：悬停门扇 → 高亮描层 + 指针光标 + 「点击开 / 关门」气泡（桌面端悬停可用）
      const doorHi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#b5653a', transparent: true, opacity: .26, depthWrite: false }));
      doorHi.visible = false; scene.add(doorHi); doorHiRef = doorHi;
      const doorTip = document.createElement('div'); doorTip.id = 'doorTip'; document.body.appendChild(doorTip);
      // 光标三态：选择 = 系统默认箭头；移动 = 四向箭头；其它绘制工具 = 十字（与 2D 一致）
      const cursorForTool = () => {
        if (ui.tool === 'draw' && !m3dPreview) {
          if (ui.drawTool === 'move') return 'move';
          if (ui.drawTool !== 'select') return 'crosshair';
        }
        return '';
      };
      let doorHover = null;
      const clearDoorHover = () => {
        if (doorHover) { doorHi.removeFromParent(); doorHi.visible = false; doorHover = null; }
        cv.style.cursor = cursorForTool(); doorTip.classList.remove('open');
      };
      window.clearDoorHover = clearDoorHover;
      window.clearDoorHi = () => { if (doorHover) { doorHi.removeFromParent(); doorHi.visible = false; doorHover = null; } };   // 只清高亮框、保留提示气泡（交互高亮开关用）
      cv.addEventListener('pointermove', e => {
        if (fdrag || objdrag) return;                           // 拖动中保留工具光标，不被悬停逻辑清掉
        const baseCur = cursorForTool();
        if (!active || anim || opt.mode !== 'orbit' || e.pointerType !== 'mouse' || !matchMedia('(hover:hover)').matches) { cv.style.cursor = baseCur; doorTip.classList.remove('open'); return; }
        const h = pick(e);
        if (baseCur === 'move') {                               // 移动工具：四向箭头
          clearDoorHover(); cv.style.cursor = 'move'; return;
        }
        if (baseCur === 'crosshair') {                          // 其它绘制工具：十字
          clearDoorHover(); cv.style.cursor = 'crosshair'; return;
        }
        if (h?.liftBtn && h.mesh) {                                      // 电梯呼叫 / 选层 / 开关门按钮：高亮命中盒 + 气泡提示（与门同款反馈）
          if (doorHover !== h.mesh) {
            doorHover = h.mesh;
            if (opt.hi !== false) {                                     // 「交互高亮」关闭时只出气泡、不挂高亮框
              const p = h.mesh.geometry.parameters;
              doorHi.removeFromParent(); doorHi.visible = true;
              doorHi.scale.set((p.width || .05) * 1.5, (p.height || .05) * 1.5, (p.depth || .02) + .04);
              h.mesh.add(doorHi);
            }
          }
          cv.style.cursor = baseCur;
          doorTip.textContent = liftBtnTip(h.liftBtn, false);
          doorTip.classList.add('open');
          doorTip.style.left = e.clientX + 'px'; doorTip.style.top = e.clientY + 'px';
        } else if ((h?.door || h?.carWin) && h.mesh) {
          if (doorHover !== h.mesh) {                                    // 换门：把高亮层挂到新门扇（随开门动画一起转）
            doorHover = h.mesh;
            if (opt.hi !== false) {                                     // 「交互高亮」关闭时只出气泡、不挂高亮框
              const p = h.mesh.geometry.parameters;                     // 车门玻璃是 BufferGeometry 没有 parameters：用世界包围盒兜底
              if (p) doorHi.scale.set(p.width * 1.05, p.height * 1.05, p.depth + .06);
              else { const bb = new THREE.Box3().setFromObject(h.mesh), sz = bb.getSize(new THREE.Vector3());
                bb.getCenter(doorHi.position); doorHi.scale.set(Math.max(.05,sz.x)*1.05, Math.max(.05,sz.y)*1.05, Math.max(.02,sz.z)+.06); }
              doorHi.removeFromParent(); doorHi.visible = true;
              h.mesh.add(doorHi);
            }
          }
          cv.style.cursor = baseCur;                              // 光标服从当前工具：选择=原鼠标，移动=四箭头，绘制=十字
          doorTip.textContent = h.carWin
            ? tr(`点击按钮${h.carWin.open ? '升起' : '降下'}${h.carWin.label[0]}`, `Click to ${h.carWin.open ? 'raise' : 'lower'} ${h.carWin.label[1]}`)
            : h.door.kind === 'car'
            ? tr(`点击门把手${h.door.open ? '关上' : '打开'}${h.door.label[0]}`, `Click the handle to ${h.door.open ? 'close' : 'open'} ${h.door.label[1]}`)
            : h.door.win
            ? (h.door.open ? tr('点击关窗', 'Click to close') : tr('点击开窗', 'Click to open'))
            : (h.door.open ? tr('点击关门', 'Click to close') : tr('点击开门', 'Click to open'));
          doorTip.classList.add('open');
          doorTip.style.left = e.clientX + 'px'; doorTip.style.top = e.clientY + 'px';
        } else if (h?.flagSel || h?.flagHandle) {                      // 旗杆：同款气泡提示升 / 降旗
          cv.style.cursor = baseCur;                              // 光标服从当前工具：选择=原鼠标，移动=四箭头，绘制=十字
          const ex = (state.extras || []).find(x => x.id === (h.flagSel || h.flagHandle));
          const top = ex ? (ex.h ?? 6000) : 6000;
          const up = ex && (ex.flagY ?? Math.round(top * .9)) > top * .6;
          doorTip.textContent = up ? tr('点击降旗', 'Click to lower the flag') : tr('点击升旗', 'Click to raise the flag');
          doorTip.classList.add('open');
          doorTip.style.left = e.clientX + 'px'; doorTip.style.top = e.clientY + 'px';
        } else if (h?.kind === 'lamp') {                              // 灯具 / 灯开关：鸟瞰模式悬停提示开 / 关（与门提示一样不限制相机距离）
          const l = (state.lamps || []).find(x => x.id === h.id);
          if (!l || PASSIVE_LAMP_TYPES.includes(l.type)) { clearDoorHover(); return; }   // 插座 / 网络插座无开关交互
          let tip;
          if (isSwitchType(l.type)) {
            const near = switchTargets(l);
            const anyOff = near.some(x => x.on === false);
            tip = !near.length ? tr('此开关未控制灯具', 'Switch controls no lamps')
              : anyOff ? tr('点击打开所控灯', 'Click to turn controlled lamps on') : tr('点击关闭所控灯', 'Click to turn controlled lamps off');
          } else tip = l.on !== false ? tr('点击关灯', 'Click to turn off') : tr('点击开灯', 'Click to turn on');
          cv.style.cursor = baseCur;
          doorTip.textContent = tip;
          doorTip.classList.add('open');
          doorTip.style.left = e.clientX + 'px'; doorTip.style.top = e.clientY + 'px';
        } else if (h?.kind === 'streetlamp' || h?.kind === 'solarlamp' || h?.kind === 'traflight' || h?.kind === 'facLaneLight' || h?.gateArm || h?.park) {   // 路灯 / 信号灯 / 车道灯 / 道闸 / 停车场设备：整体高亮 + 动作提示
          const ex = (state.extras || []).find(x => String(x.id) === String(h.id || h.gateArm || h.park?.id));
          const gl = ex && archUp.children.find(o => o.userData.pick3d && String(o.userData.pick3d.id) === String(ex.id) && (o.userData.pick3d.kind === ex.type || o.userData.pick3d.kind === 'extra'));
          if (!gl) { clearDoorHover(); return; }
          if (doorHover !== gl) {                                        // 高亮层挂到场景：灯杆是 Group 无 geometry 参数，用世界包围盒（排除光晕精灵，避免框比灯大）
            doorHover = gl;
            if (opt.hi !== false) {                                     // 「交互高亮」关闭时只出气泡、不挂高亮框
              const bb = new THREE.Box3();
              gl.children.forEach(c => { if (!c.isSprite) bb.expandByObject(c); });
              if (bb.isEmpty()) { clearDoorHover(); return; }
              const s = bb.getSize(new THREE.Vector3());
              doorHi.removeFromParent(); doorHi.visible = true;
              doorHi.scale.set(Math.max(.05, s.x) * 1.08, Math.max(.05, s.y) * 1.08, Math.max(.05, s.z) * 1.08);
              bb.getCenter(doorHi.position); scene.add(doorHi);
            }
          }
          cv.style.cursor = baseCur;
          if (ex.type === 'traflight') {
            doorTip.textContent = tr('点击切换信号灯 · 当前', 'Click to cycle the signal · now ') + TRAFFIC_SIGNS_ZH[ex.sig || 'red'];
          } else if (ex.type === 'facLaneLight') {
            doorTip.textContent = tr('点击切换车道灯 · 当前', 'Click to toggle lane light · now ') + (ex.sig === 'green' ? tr('绿灯通行', 'green · go') : tr('红灯禁行', 'red · stop'));
          } else if (ex.type === 'facBarrierGate') {
            doorTip.textContent = ex.open === true ? tr('点击落下道闸 · 禁行', 'Click to lower barrier · stop') : tr('点击抬起道闸 · 放行', 'Click to raise barrier · go');
          } else if (h.park) {
            const k = h.park.kind;
            doorTip.textContent = k === 'stack'
              ? (ex.st?.[h.park.cell] ? tr(`点击取车 · ${h.park.lv}F ${h.park.col} 号车位`, `Click to take the car · L${h.park.lv} no.${h.park.col}`) : tr(`点击存车 · ${h.park.lv}F ${h.park.col} 号车位`, `Click to park · L${h.park.lv} no.${h.park.col}`))
              : k === 'bollard' ? (ex.up ? tr('点击落下升降柱 · 放行', 'Click to lower bollard · go') : tr('点击升起升降柱 · 禁行', 'Click to raise bollard · stop'))
              : k === 'gate' ? (ex.open ? tr('点击展开伸缩门 · 关闭', 'Click to unfold gate · close') : tr('点击收拢伸缩门 · 放行', 'Click to fold gate · open'))
                : k === 'sensor' ? (ex.occ ? tr('点击切为空位 · 绿灯', 'Click to set free · green') : tr('点击切为有车 · 红灯', 'Click to set occupied · red'))
                  : k === 'san' ? (() => {
                      if (ex.type === 'sanSortBin') {
                        const CN = ['蓝', '红', '绿', '灰'], EN = ['blue', 'red', 'green', 'grey'], part = h.park.part ?? 0;
                        const open = sanBinStates(ex)[part] === true;
                        return tr(`点击${open ? '合上' : '打开'}${CN[part]}桶盖`, `Click to ${open ? 'close' : 'open'} the ${EN[part]} lid`);
                      }
                      if (ex.type === 'sanCollectPoint' && h.park.part != null) {
                        const part = h.park.part;
                        const sv = sanVisuals.get(String(ex.id)), n = sv?.cpAnims?.length || Math.max(2, Math.round(M(ex.w || 2400) / .7));
                        const open = cpBinStates(ex, n)[part] === true;
                        return tr(`点击${open ? '合上' : '打开'}第 ${part + 1} 个桶盖`, `Click to ${open ? 'close' : 'open'} bin ${part + 1} lid`);
                      }
                      if (ex.type === 'sanRecycleStation' && h.park.part != null) {
                        const CN = ['蓝', '红', '绿'], EN = ['blue', 'red', 'green'], part = h.park.part;
                        const open = sanPortStates(ex)[part] === true;
                        return tr(`点击${open ? '合上' : '打开'}${CN[part]}色投放口`, `Click to ${open ? 'close' : 'open'} the ${EN[part]} port`);
                      }
                      const S = SAN_TOAST[ex.type] || ['开启', '关闭', 'On', 'Off'];
                      return tr(`点击${ex.on ? S[1] : S[0]}`, `Click to ${ex.on ? S[3] : S[2]}`);
                    })()
                  : k === 'wt' ? (() => {
                      const S = WT_TOAST[ex.type] || ['开启', '关闭', 'On', 'Off'];
                      return tr(`点击${ex.on ? S[1] : S[0]}`, `Click to ${ex.on ? S[3] : S[2]}`);
                    })()
                  : k === 'wash' ? (ex.busy ? tr('洗车进行中 · 请稍候', 'Washing · please wait') : tr('点击启动洗车', 'Click to start the wash'))
                  : k === 'sanSwitch' ? (ex.on ? tr('点击关灯（门边开关）', 'Click to turn off (wall switch)') : tr('点击开灯（门边开关）', 'Click to turn on (wall switch)'))
                  : k === 'sandoor' ? (ex.doorOpen !== false ? tr('点击关门', 'Click to close the door') : tr('点击开门', 'Click to open the door'))
                  : k === 'sancab' ? (ex.cabOpen === true ? tr('点击关上柜门', 'Click to close the cabinet door') : tr('点击打开柜门', 'Click to open the cabinet door'))
                  : (ex.busy ? tr('点击切为空闲 · 绿灯', 'Click to set idle · green') : tr('点击切为充电中 · 蓝灯', 'Click to set charging · blue'));
          } else {
            const empty = ex.type === 'solarlamp' && (ex.battery ?? 0) <= 0;
            doorTip.textContent = ex.on === false
              ? (empty ? tr('点击开灯（电量不足，白天自动充电）', 'Click to turn on (battery empty, charges by day)') : tr('点击开灯', 'Click to turn on'))
              : tr('点击关灯', 'Click to turn off');
          }
          doorTip.classList.add('open');
          doorTip.style.left = e.clientX + 'px'; doorTip.style.top = e.clientY + 'px';
        } else clearDoorHover();
      });
      cv.addEventListener('pointerleave', clearDoorHover);

      new ResizeObserver(() => {
        renderer.setSize(SW(), SH()); labelRenderer.setSize(SW(), SH());
        camera.aspect = SW() / SH(); camera.updateProjectionMatrix();
      }).observe(stage);
      bindUI();
    }

    /* ======================= 材质 ======================= */
    const matCache = new Map();
    let envTex = null, envK = 1;
    function mat(color, o = {}) {
      const key = color + JSON.stringify(o);
      if (!matCache.has(key)) {
        const m = new THREE.MeshStandardMaterial({ color, roughness: .7, ...o });
        // 金属 / 光滑表面挂环境反射，墙面等哑光材质不挂，避免整体变亮
        if (envTex && (m.metalness > 0 || m.roughness < .4)) { m.envMap = envTex; m.userData.env = m.metalness > .5 ? 1 : .5; m.envMapIntensity = m.userData.env * envK; }
        matCache.set(key, m);
      }
      return matCache.get(key);
    }
    function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    const rgbK = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(v * k))); return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`; };
    // 地面贴图按真实尺寸平铺（UV 单位 = 米）
    const TEX = {
      wood: { sx: 1.8, sy: .36, base: '#d6b58a', rough: .55 }, walnut: { sx: 1.8, sy: .36, base: '#9a6f4b', rough: .5 },
      tile800: { sx: .8, sy: .8, base: '#ebe6dd', grout: '#cfc6b7', rough: .3 }, tile600: { sx: .6, sy: .6, base: '#dfe3e0', grout: '#bfc6c1', rough: .35 },
      antislip: { sx: .3, sy: .3, base: '#d3d8d4', grout: '#aab2ac', rough: .8 }, marble: { sx: 1.2, sy: 1.2, base: '#f2efe9', grout: '#d9d2c4', rough: .18 },
      terrazzo: { sx: .5, sy: .5, base: '#e6dfd3', rough: .4 }, carpet: { sx: .3, sy: .3, base: '#c6bfd2', rough: 1 },
    };
    const floorMats = {};
    function floorMat(kind) {
      if (floorMats[kind]) return floorMats[kind];
      const s = TEX[kind] || TEX.tile800, R = rng(kind.length * 977 + 13), cv = document.createElement('canvas');
      const wood = kind === 'wood' || kind === 'walnut';
      cv.width = wood ? 1024 : 512; cv.height = wood ? 205 : 512;
      const g = cv.getContext('2d'), W = cv.width, Hh = cv.height;
      g.fillStyle = s.base; g.fillRect(0, 0, W, Hh);
      if (wood) {
        const rowH = Hh / 2, joints = [[W * 2 / 3], [W / 3]];
        for (let r = 0; r < 2; r++) {
          let x0 = 0;
          [...joints[r], W].forEach(x1 => {
            g.fillStyle = rgbK(s.base, .9 + R() * .2); g.fillRect(x0, r * rowH, x1 - x0, rowH);
            g.strokeStyle = rgbK(s.base, .8); g.globalAlpha = .35; g.lineWidth = 1.2;
            for (let k = 0; k < 7; k++) {
              const y = r * rowH + 6 + R() * (rowH - 12); g.beginPath(); g.moveTo(x0, y);
              for (let x = x0; x <= x1; x += 40) g.lineTo(x, y + Math.sin(x * .02 + k) * 2.5); g.stroke();
            }
            g.globalAlpha = 1; g.fillStyle = rgbK(s.base, .62); g.fillRect(x1 - 1.5, r * rowH, 3, rowH); x0 = x1;
          });
          g.fillStyle = rgbK(s.base, .62); g.fillRect(0, r * rowH, W, 2.5);
        }
      } else if (kind === 'marble') {
        g.strokeStyle = 'rgba(160,150,135,.35)';
        for (let k = 0; k < 6; k++) { g.lineWidth = 1 + R() * 3; g.beginPath(); g.moveTo(R() * W, 0); g.bezierCurveTo(R() * W, R() * Hh, R() * W, R() * Hh, R() * W, Hh); g.stroke(); }
      } else if (kind === 'terrazzo') {
        const cs = ['#b9a58c', '#8fa3a0', '#c9b7a2', '#a88f76', '#7e8a86'];
        for (let k = 0; k < 160; k++) { g.fillStyle = cs[k % 5]; g.beginPath(); g.arc(R() * W, R() * Hh, 2 + R() * 7, 0, 7); g.fill(); }
      } else {
        for (let k = 0; k < 1500; k++) { g.fillStyle = `rgba(0,0,0,${R() * .04})`; g.fillRect(R() * W, R() * Hh, 2, 2); }
      }
      if (s.grout) { g.fillStyle = s.grout; g.fillRect(0, 0, W, 3); g.fillRect(0, 0, 3, Hh); }
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / s.sx, 1 / s.sy);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return floorMats[kind] = new THREE.MeshStandardMaterial({ map: t, roughness: s.rough, side: THREE.DoubleSide });   // 楼板双面：整栋模式下从下层仰望也能看到上层楼板底面，不会"看起来是空的"
    }
    // 开关 / 插座面板材质：白色塑料 / 木纹 / 不锈钢 / 玻璃
    const panelMats = {};
    function panelMat(kind) {
      const k = PANEL_MATS[kind] ? kind : 'plastic';
      if (panelMats[k]) return panelMats[k];
      let m;
      if (k === 'steel') m = mat('#c9ced3', { metalness: .92, roughness: .22 });
      else if (k === 'glass') {
        m = new THREE.MeshPhysicalMaterial({ color: '#cfe6ef', roughness: .06, metalness: .05, transparent: true, opacity: .55, depthWrite: false, side: THREE.DoubleSide });
        if (envTex) { m.envMap = envTex; m.envMapIntensity = .8; }
      } else if (k === 'wood') {
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
        const g = cv.getContext('2d'), R = rng(4211);
        g.fillStyle = '#a8794f'; g.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 40; i++) {
          g.strokeStyle = rgbK('#a8794f', .72 + R() * .4); g.globalAlpha = .45; g.lineWidth = .8 + R() * 2;
          const y = R() * 256; g.beginPath(); g.moveTo(0, y);
          for (let x = 0; x <= 256; x += 12) g.lineTo(x, y + Math.sin(x * .045 + i) * 2.2); g.stroke();
        }
        g.globalAlpha = 1;
        const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
        m = new THREE.MeshStandardMaterial({ map: t, roughness: .5 });
      } else m = mat('#e8e2d6', { roughness: .65 });
      return panelMats[k] = m;
    }

    /* ======================= 几何小工具（y = 底面高度） ======================= */
    const asMat = m => typeof m === 'string' ? mat(m) : m;
    const sh = o => { o.castShadow = o.receiveShadow = true; return o; };
    const mesh = (geo, m) => sh(new THREE.Mesh(geo, asMat(m)));
    const rot = (o, x = 0, y = 0, z = 0) => { o.rotation.set(x, y, z); return o; };
    function box(w, h, d, m, x = 0, y = 0, z = 0) {
      const o = mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y + h / 2, z); return o;
    }
    function rbox(w, h, d, m, x = 0, y = 0, z = 0, r = .04) {
      const o = mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - .001, h / 2 - .001, d / 2 - .001)), m); o.position.set(x, y + h / 2, z); return o;
    }
    function cyl(rt, rb, h, m, x = 0, y = 0, z = 0, seg = 28) {
      const o = mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); o.position.set(x, y + h / 2, z); return o;
    }
    // 旋转体：pts = [[半径, 高度], …] 自下而上，y = 底面
    function lathe(pts, m, x = 0, y = 0, z = 0, seg = 40) {
      const o = mesh(new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(Math.max(r, 1e-4), h)), seg), m); o.position.set(x, y, z); return o;
    }
    // 两点之间的圆杆，r0 在 a 端、r1 在 b 端（收分椅腿、斜撑）
    function rod(a, b, r0, m, r1 = r0, seg = 12) {
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), o = mesh(new THREE.CylinderGeometry(r1, r0, A.distanceTo(B), seg), m);
      o.position.copy(A).add(B).multiplyScalar(.5); o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.sub(A).normalize()); return o;
    }
    // 沿曲线的圆管（水龙头、扶手、灯臂）
    const tube = (pts, r, m, seg = 40) => mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), false, 'centripetal'), seg, r, 10), m);
    // 椭球（靠垫、叶片、豆袋），y = 中心
    function blob(rx, ry, rz, m, x = 0, y = 0, z = 0, seg = 24) {
      const o = mesh(new THREE.SphereGeometry(1, seg, Math.round(seg * .7)), m); o.scale.set(rx, ry, rz); o.position.set(x, y, z); return o;
    }
    // 水平圆环，y = 中心
    function ring(R, r, m, x = 0, y = 0, z = 0) { const o = mesh(new THREE.TorusGeometry(R, r, 10, 48), m); o.rotation.x = Math.PI / 2; o.position.set(x, y, z); return o; }
    function rrect(w, d, r) {
      const s = new THREE.Shape(), x = -w / 2, y = -d / 2; r = Math.min(r, w / 2 - .001, d / 2 - .001);
      s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
      s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
    }
    // 中空圆角框（浴缸、水槽沿、椅背框）：外 w×d、壁厚 t、高 h
    function shell(w, d, h, t, r, m, x = 0, y = 0, z = 0) {
      const s = rrect(w, d, r); s.holes.push(rrect(w - 2 * t, d - 2 * t, Math.max(.004, r - t)));
      const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 10 }); geo.rotateX(-Math.PI / 2);
      const o = mesh(geo, m); o.position.set(x, y, z); return o;
    }
    const darker = (hex, k = .8) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
    const lighter = (hex, k = .2) => '#' + new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), k).getHexString();
    // 四条收分腿：inset 为距边距离，r 为腿底半径（顶部略粗）
    const legs = (g, w, d, h, m, inset = .05, r = .02) => [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => g.add(rod([a * (w / 2 - inset), 0, b * (d / 2 - inset)], [a * (w / 2 - inset), h, b * (d / 2 - inset)], r * .7, m, r)));
    const metal = () => mat('#cfd2d4', { metalness: .9, roughness: .25 });
    const chrome = () => mat('#eef0f2', { metalness: 1, roughness: .08 });
    const hwMat = () => mat('#b9b3a8', { metalness: .85, roughness: .3 });
    const blackMetal = () => mat('#2b2b2d', { metalness: .6, roughness: .4 });
    const mirror = () => mat('#dfeaee', { metalness: .55, roughness: .06 });
    const ceramic = (o = {}) => mat('#fbfbf9', { roughness: .12, ...o });
    const fabric = c => mat(c, { roughness: .96 });
    const woodM = c => mat(c, { roughness: .55 });
    const screenMat = (glow = '#1a2636') => mat('#0b0e13', { roughness: .1, metalness: .3, emissive: glow, emissiveIntensity: .35 });
    const glowMat = (c = '#fff4dc', e = '#ffdca0', k = .5) => mat(c, { emissive: e, emissiveIntensity: k, roughness: .9, side: THREE.DoubleSide });

    // 拉手：y 为拉手中心，z 为门板正面
    function pull(g, len, vert, x, y, z) {
      const m = hwMat(), o = new THREE.Group();
      o.add(vert ? box(.01, len, .01, m, 0, -len / 2, .028) : box(len, .01, .01, m, 0, -.005, .028));
      [-1, 1].forEach(s => o.add(vert ? box(.008, .008, .028, m, 0, s * (len / 2 - .015) - .004, .014) : box(.008, .008, .028, m, s * (len / 2 - .015), -.004, .014)));
      o.position.set(x, y, z); g.add(o);
    }
    function knob(g, x, y, z) { const k = cyl(.011, .014, .02, hwMat(), x, y - .01, z + .01, 16); k.rotation.x = Math.PI / 2; g.add(k, blob(.014, .014, .008, hwMat(), x, y, z + .022, 12)); }
    // 柜门 / 抽屉面板：x0..x0+w、y0..y0+h 区域内 nx 列 × ny 行，正面朝 +z（z = 柜体正面）
    // hd：'bar' 金属拉手 | 'knob' 圆钮 | 'edge' 顶部隐形拉槽 | 'none'；hy：门拉手中心高度（null = 面板中部）
    function fronts(g, x0, y0, w, h, z, nx, ny, m, hd = 'bar', hy = null) {
      const gap = .005, pw = w / nx, ph = h / ny, fz = z + .018;
      g.add(box(w, h, .002, '#2a2724', x0 + w / 2, y0, z + .001));                     // 缝隙里透出的暗色
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const cx = x0 + pw * (i + .5), yb = y0 + ph * j, drawer = ph < .4 && pw >= ph;
        g.add(rbox(pw - gap, ph - gap, .018, m, cx, yb + gap / 2, z + .009, .003));
        if (hd === 'none') continue;
        if (hd === 'edge') { g.add(box(pw - .05, .01, .006, '#3c3a37', cx, yb + ph - gap - .018, fz)); continue; }
        if (drawer) { hd === 'knob' ? knob(g, cx, yb + ph / 2, fz) : pull(g, Math.min(.3, pw * .45), false, cx, yb + ph / 2, fz); continue; }
        const len = Math.min(.45, ph * .35), hx = nx === 1 ? cx + pw / 2 - .045 : (i % 2 ? cx - pw / 2 + .04 : cx + pw / 2 - .04);
        const y = Math.min(yb + ph - .05 - len / 2, Math.max(yb + .05 + len / 2, hy ?? yb + ph / 2));
        hd === 'knob' ? knob(g, hx, y, fz) : pull(g, len, true, hx, y, fz);
      }
    }
    const vasePts = (r, h) => [[0, 0], [r * .65, 0], [r, h * .32], [r * .92, h * .62], [r * .42, h * .86], [r * .5, h]];
    function vase(g, x, y, z, r, h, c, R, flowers = true) {
      g.add(lathe(vasePts(r, h), mat(c, { roughness: .35, side: THREE.DoubleSide }), x, y, z, 32));
      if (!flowers) return;
      const cols = ['#f3e6d8', '#e8b4a0', '#f6d27a', '#ffffff'];
      for (let k = 0; k < 5; k++) {
        const a = k * 1.26 + R() * .4, s = .03 + R() * .05, top = [x + Math.cos(a) * s, y + h + .12 + R() * .14, z + Math.sin(a) * s];
        g.add(rod([x, y + h * .6, z], top, .003, '#6f8f4a', .003, 6), blob(.022, .018, .022, cols[k % 4], ...top, 12));
      }
    }
    function tableLamp(g, x, y, z, s = 1) {
      g.add(lathe([[0, 0], [.06 * s, 0], [.075 * s, .05 * s], [.08 * s, .12 * s], [.055 * s, .2 * s], [.018 * s, .25 * s], [.012 * s, .3 * s]], ceramic({ roughness: .3 }), x, y, z, 32));
      g.add(lathe([[.13 * s, 0], [.1 * s, .18 * s]], glowMat('#f6ecd9', '#ffdca0', .35), x, y + .26 * s, z, 40), blob(.03 * s, .03 * s, .03 * s, glowMat('#fff', '#ffe2b0', 1), x, y + .31 * s, z, 12));
    }
    const plate = (g, r, x, y, z) => g.add(lathe([[0, 0], [r * .6, 0], [r * .72, .008], [r, .02]], ceramic({ side: THREE.DoubleSide }), x, y, z, 32));

    /* ======================= 家具模型（局部坐标：背面朝 -z） ======================= */
    function poultryModel(g, f, w, d, c, R) {
      const t = f.type, bm = mat(c, { roughness: .92 }), skin = mat('#e8a23c', { roughness: .7 });
      const dark = mat('#2b2724', { roughness: .5 }), red = mat('#c9433a', { roughness: .75 });
      const body = new THREE.Group(); g.add(body);
      const big = t === 'goose' ? 1.18 : (t === 'duck' ? 1.02 : .92);
      const bw = w * .3 * big, bh = (t === 'duck' ? .14 : .18) * big, bd = d * .34 * big;
      const by = .17 + bh;
      body.add(blob(bw, bh, bd, bm, 0, by, 0, 20));
      [-1, 1].forEach(s => { const wg = blob(bw * .5, bh * .48, bd * .46, mat(darker(c, .86), { roughness: .9 }), s * bw * .76, by + bh * .1, 0, 14); wg.rotation.z = s * .22; body.add(wg); });
      for (let k = -1; k <= 1; k++) { const tf = blob(bw * .18, bh * .5, bd * .28, mat(darker(c, .8), { roughness: .9 }), k * bw * .26, by + bh * .72, bd * .9, 12); tf.rotation.x = -.5; body.add(tf); }
      const legX = bw * .3, legs = [];
      [-1, 1].forEach(s => {
        const leg = new THREE.Group(); leg.position.set(s * legX, .17, .01);
        leg.add(rod([0, 0, 0], [0, -.145, .01], .012, skin, .012, 8));
        leg.add(box(.075, .012, .09, skin, 0, -.17, -.03));
        g.add(leg); legs.push(leg);
      });
      const hz = -bd * .86, hy = by + bh * (t === 'goose' ? 1.8 : 1.1);
      if (t === 'goose') body.add(rod([0, by, -bd * .45], [0, hy - bw * .16, hz + bw * .08], .042, bm, .036, 12));
      else if (t === 'duck') body.add(blob(bw * .12, bw * .12, bw * .12, bm, 0, by + bh * .25, -bd * .6, 16));
      const head = new THREE.Group(); head.position.set(0, hy, hz);
      head.add(blob(bw * .35, bw * .35, bw * .35, bm, 0, 0, 0, 18));
      if (t === 'duck' || t === 'goose') head.add(rbox(bw * .34, .022, bw * .4, skin, 0, -bw * .07, -bw * .33, .008));
      else {
        head.add(rot(cyl(.006, bw * .12, bw * .28, skin, 0, -bw * .05, -bw * .24, 12), Math.PI / 2, 0, 0));
        head.add(blob(bw * .09, bw * .13, bw * .06, red, 0, -bw * .19, -bw * .05, 12));
        for (let k = 0; k < 3; k++) head.add(blob(bw * .085, bw * .1, bw * .05, red, (k - 1) * bw * .12, bw * .3, bw * .02, 10));
      }
      [-1, 1].forEach(s => head.add(blob(.013, .013, .013, dark, s * bw * .23, bw * .07, -bw * .19, 10)));
      body.add(head);
      // 随机漫步状态：以放置点为圆心，在半径内随机选目标点慢行，到达后停留片刻再换目标
      const homeX = wx(f.cx), homeZ = wz(f.cy), roam = 10;
      g.userData.poultry = {
        phase: R() * Math.PI * 2, body, head, legs, homeX, homeZ, roam,
        speed: .3 + R() * .2, heading: R() * Math.PI * 2,
        tx: homeX, tz: homeZ, wait: R() * 1.2, gait: 0
      };
    }
    /* 野生动物：与家禽共用随机漫步 / 避障 / 实时碰撞体系（userData.poultry 键名沿用，主循环与 blocked() 均按此识别动物），仅模型与速度 / 活动半径不同 */
    function wildAnimalModel(g, f, w, d, c, R) {
      const t = f.type, bm = mat(c, { roughness: .92 });
      const dark = mat('#2b2724', { roughness: .5 });
      const body = new THREE.Group(); g.add(body);
      const legs = [];
      let head = null, speed = .3 + R() * .2, roam = 8;   // head 在各 case 内创建（块级作用域），switch 后统一写入 userData
      const eye = (h, hx, hy, hz, s = .011) => [-1, 1].forEach(k => h.add(blob(s, s, s, dark, k * hx, hy, hz, 10)));
      const quadLegs = (hipY, hipX, zF, zB, r) => [-1, 1].forEach(s => {           // 四足动物：左右各一组（同侧前 + 后腿），主循环按交替步态摆动整组
        const leg = new THREE.Group(); leg.position.set(s * hipX, hipY, 0);
        leg.add(rod([0, 0, zF], [0, -hipY, zF], r, bm, r * .8, 8), rod([0, 0, zB], [0, -hipY, zB], r * 1.15, bm, r * .9, 8));
        g.add(leg); legs.push(leg);
      });
      switch (t) {
        case 'rabbit': case 'petrabbit': {
          const bw = w * .3, bd = d * .42;
          body.add(blob(bw, .12, bd, bm, 0, .13, .01, 18));
          const hm = mat(darker(c, .88), { roughness: .9 });
          [-1, 1].forEach(s => {                                   // 后腿：粗大大腿 + 长后脚，挂在身体上随跳跃蹬伸（与双前爪一起动）
            const leg = new THREE.Group(); leg.position.set(s * bw * .5, .13, bd * .25);
            leg.add(blob(bw * .45, .075, bd * .42, hm, 0, -.025, .05, 14), rbox(.05, .022, .1, bm, 0, -.118, .08, .008));
            body.add(leg); legs.push(leg);
          });
          body.add(blob(.034, .034, .034, mat('#f4f1ea', { roughness: .9 }), 0, .12, bd * .9, 12));   // 短尾
          head = new THREE.Group(); head.position.set(0, .2, -bd * .55);
          head.add(blob(.072, .068, .072, bm, 0, 0, 0, 16));
          [-1, 1].forEach(s => { const ear = blob(.026, .095, .014, bm, s * .028, .11, .012, 12); ear.rotation.z = s * (t === 'petrabbit' ? .95 : .18); ear.rotation.x = t === 'petrabbit' ? -.3 : -.12; head.add(ear); });   // 宠物兔垂耳
          body.add(head); eye(head, .045, .02, -.052);
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * bw * .5, .1, .01); leg.add(rod([0, 0, 0], [0, -.1, 0], .012, bm, .01, 8), box(.05, .014, .055, bm, 0, -.105, -.012)); g.add(leg); legs.push(leg); });
          speed = .4 + R() * .25; roam = t === 'petrabbit' ? 6 : 8;
          break;
        }
        case 'squirrel': {
          body.add(blob(.06, .085, .085, bm, 0, .12, .01, 16));
          const tm = mat(darker(c, .85), { roughness: .95 });                      // 蓬松大尾上卷
          body.add(blob(.045, .05, .05, bm, 0, .2, .1, 14), blob(.055, .055, .055, tm, 0, .27, .13, 14), blob(.05, .05, .05, tm, 0, .32, .06, 14));
          head = new THREE.Group(); head.position.set(0, .21, -.06);
          head.add(blob(.052, .05, .052, bm, 0, 0, 0, 14));
          [-1, 1].forEach(s => head.add(blob(.016, .024, .012, bm, s * .03, .048, .01, 10)));
          body.add(head); eye(head, .032, .015, -.04);
          [-1, 1].forEach(s => {                                   // 四条腿：左右各一组（同侧前 + 后），主循环按交替步态摆动
            const leg = new THREE.Group(); leg.position.set(s * .04, .09, 0);
            leg.add(rod([0, 0, -.045], [0, -.09, -.045], .008, bm, .007, 8), rod([0, 0, .045], [0, -.09, .045], .009, bm, .007, 8));
            g.add(leg); legs.push(leg);
          });
          speed = .35 + R() * .15; roam = 7;
          break;
        }
        case 'hedgehog': {
          body.add(blob(.085, .06, .1, mat('#5c5148', { roughness: .95 }), 0, .11, .02, 18));          // 背上棘刺外衣
          const spikeM = mat('#453c34', { roughness: 1 });
          for (let k = 0; k < 14; k++) {                                           // 外衣上散布小刺
            const a = R() * Math.PI * 2, rr = .015 + R() * .05;
            const sp = cyl(.001, .006, .038, spikeM, Math.cos(a) * rr, .155, .02 + Math.sin(a) * rr * .85, 6);
            sp.rotation.z = Math.cos(a) * .55; sp.rotation.x = -Math.sin(a) * .55;
            body.add(sp);
          }
          head = new THREE.Group(); head.position.set(0, .08, -.1);
          head.add(blob(.05, .045, .07, mat('#d9c8ac', { roughness: .9 }), 0, 0, .01, 14));            // 尖脸
          head.add(blob(.013, .013, .016, dark, 0, -.008, -.045, 10));                                 // 鼻头
          body.add(head); eye(head, .032, .018, -.032);
          const lm = mat('#d9c8ac', { roughness: .9 });
          [-1, 1].forEach(s => {                                   // 四条短腿：左右各一组（同侧前 + 后），主循环按交替步态摆动
            const leg = new THREE.Group(); leg.position.set(s * .045, .07, 0);
            leg.add(rod([0, 0, -.05], [0, -.07, -.05], .01, lm, .008, 8), rod([0, 0, .05], [0, -.07, .05], .011, lm, .008, 8));
            g.add(leg); legs.push(leg);
          });
          speed = .12 + R() * .06; roam = 5;
          break;
        }
        case 'fox': case 'wolf': {
          const bd = .19, hipY = .27, white = mat('#f2ede4', { roughness: .9 });
          body.add(blob(.15, .14, bd, bm, 0, hipY, 0, 20));
          if (t === 'wolf') body.add(blob(.12, .045, bd * .7, mat('#55534f', { roughness: .95 }), 0, hipY + .12, 0, 16));   // 狼背鬃毛
          else body.add(blob(.05, .06, .06, white, 0, hipY - .05, -bd * .5, 12));   // 胸口白毛
          head = new THREE.Group(); head.position.set(0, .38, -bd * .72);
          head.add(blob(.082, .078, .09, bm, 0, 0, 0, 18));
          head.add(rbox(.05, .045, .1, bm, 0, -.02, -.08, .015));                  // 尖吻
          head.add(blob(.02, .02, .025, dark, 0, -.015, -.135, 10));               // 鼻头
          [-1, 1].forEach(s => { const ear = cyl(.004, .032, .07, bm, s * .045, .075, .01, 6); ear.rotation.z = s * .22; head.add(ear); });
          body.add(head); eye(head, .05, .02, -.062);
          body.add(blob(.065, .065, .17, mat(darker(c, .92), { roughness: .95 }), 0, hipY + .04, bd * 1.05, 16));   // 蓬尾
          if (t === 'fox') body.add(blob(.05, .05, .08, white, 0, hipY + .07, bd * 1.5, 12));       // 尾尖白（狼无）
          quadLegs(hipY, .075, -bd * .5, bd * .55, .014);
          speed = .5 + R() * .2; roam = t === 'wolf' ? 18 : 14;
          break;
        }
        case 'tortoise': {
          body.add(blob(.125, .05, .105, mat('#5e7040', { roughness: .85 }), 0, .1, 0, 22));           // 龟壳穹顶
          body.add(blob(.135, .022, .115, mat('#4d5c34', { roughness: .9 }), 0, .06, 0, 20));          // 壳缘
          head = new THREE.Group(); head.position.set(0, .05, -.12);
          head.add(blob(.038, .032, .045, mat('#8b9a62', { roughness: .9 }), 0, 0, 0, 14));
          head.add(blob(.01, .01, .012, dark, 0, 0, -.032, 8));
          body.add(head);
          body.add(blob(.02, .015, .025, mat('#8b9a62', { roughness: .9 }), 0, .05, .13, 8));          // 小尾巴
          const lm = mat('#8b9a62', { roughness: .95 });
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * .09, .05, 0); leg.add(blob(.03, .05, .032, lm, 0, -.02, -.065, 10), blob(.032, .05, .034, lm, 0, -.02, .07, 10)); g.add(leg); legs.push(leg); });
          speed = .06 + R() * .04; roam = 4;
          break;
        }
        case 'deer': {
          const bd = .31, hipY = .58, spot = mat('#f6efe2', { roughness: .9 }), horn = mat('#a9855c', { roughness: .8 });
          body.add(blob(.21, .17, bd, bm, 0, hipY, 0, 22));
          [[-.1, -.08], [.12, -.1], [-.08, .04], [.14, .1], [-.12, .18], [.06, .22]].forEach(([px, pz]) => body.add(blob(.018, .02, .018, spot, px, hipY + .08, pz * bd, 10)));   // 梅花斑点
          body.add(rod([0, hipY + .1, -bd * .55], [0, hipY + .45, -bd * .75], .05, bm, .04, 10));  // 颈
          head = new THREE.Group(); head.position.set(0, hipY + .46, -bd * .75);
          head.add(blob(.075, .08, .095, bm, 0, 0, 0, 18));
          head.add(rbox(.05, .05, .1, bm, 0, -.025, -.07, .015));
          head.add(blob(.018, .018, .022, dark, 0, -.02, -.125, 10));
          [-1, 1].forEach(s => head.add(blob(.02, .04, .012, bm, s * .07, .03, .02, 10)));         // 耳
          [-1, 1].forEach(s => {                                                                    // 鹿角（主干 + 分叉）
            head.add(rod([s * .028, .05, -.01], [s * .055, .2, .01], .009, horn, .006, 6));
            head.add(rod([s * .042, .13, 0], [s * .1, .17, .03], .006, horn, .004, 6));
          });
          body.add(head); eye(head, .045, .02, -.055);
          quadLegs(hipY, .11, -bd * .45, bd * .5, .018);
          speed = .45 + R() * .25; roam = 16;
          break;
        }
        case 'cat': {
          const bd = .19, hipY = .19, white = mat('#f2ede4', { roughness: .9 });
          body.add(blob(.1, .095, bd, bm, 0, hipY + .03, .01, 18));
          body.add(blob(.05, .05, .06, white, 0, hipY - .02, -bd * .55, 12));          // 胸前白毛
          head = new THREE.Group(); head.position.set(0, hipY + .13, -bd * .78);
          head.add(blob(.07, .068, .075, bm, 0, 0, 0, 16));
          head.add(rbox(.035, .03, .05, bm, 0, -.028, -.05, .01));                     // 短吻
          head.add(blob(.011, .011, .013, dark, 0, -.025, -.085, 8));                  // 鼻头
          [-1, 1].forEach(s => { const ear = cyl(.003, .026, .05, bm, s * .042, .062, .005, 6); ear.rotation.z = s * .25; head.add(ear); });   // 三角立耳
          body.add(head); eye(head, .042, .015, -.05);
          body.add(blob(.03, .03, .05, bm, 0, hipY + .05, bd * .95, 12), blob(.034, .034, .04, bm, 0, hipY + .11, bd * 1.1, 12), blob(.032, .032, .038, bm, 0, hipY + .16, bd * .98, 12));   // 长尾上卷
          quadLegs(hipY, .055, -bd * .5, bd * .5, .011);
          speed = .45 + R() * .2; roam = 10;
          break;
        }
        case 'dog': {
          const bd = .22, hipY = .25, white = mat('#f2ede4', { roughness: .9 });
          body.add(blob(.145, .13, bd, bm, 0, hipY, 0, 20));
          body.add(blob(.06, .07, .07, white, 0, hipY - .04, -bd * .5, 12));           // 胸口白毛
          head = new THREE.Group(); head.position.set(0, hipY + .15, -bd * .72);
          head.add(blob(.085, .08, .09, bm, 0, 0, 0, 18));
          head.add(rbox(.05, .045, .09, bm, 0, -.03, -.07, .015));                     // 吻部
          head.add(blob(.018, .018, .022, dark, 0, -.03, -.12, 10));                   // 鼻头
          [-1, 1].forEach(s => { const ear = blob(.03, .075, .014, mat(darker(c, .8), { roughness: .95 }), s * .075, .015, .01, 12); ear.rotation.z = s * .45; head.add(ear); });   // 垂耳
          body.add(head); eye(head, .05, .02, -.06);
          body.add(rod([0, hipY + .1, bd * .85], [0, hipY + .24, bd * 1.1], .02, bm, .014, 8));   // 尾巴上翘
          quadLegs(hipY, .085, -bd * .5, bd * .55, .015);
          speed = .5 + R() * .2; roam = 12;
          break;
        }
        case 'hamster': {
          body.add(blob(.055, .06, .065, bm, 0, .06, .005, 16));
          head = new THREE.Group(); head.position.set(0, .09, -.045);
          head.add(blob(.045, .042, .045, bm, 0, 0, 0, 14));
          head.add(blob(.012, .012, .014, dark, 0, -.008, -.04, 8));               // 鼻
          [-1, 1].forEach(s => head.add(blob(.014, .016, .008, bm, s * .032, .04, .005, 8)));   // 小圆耳
          body.add(head); eye(head, .026, .012, -.032, .009);
          body.add(blob(.02, .02, .02, mat('#f4f0e8', { roughness: .9 }), 0, .05, .07, 8));       // 短尾
          [-1, 1].forEach(s => {                                   // 四条小腿：左右各一组
            const leg = new THREE.Group(); leg.position.set(s * .03, .055, 0);
            leg.add(rod([0, 0, -.03], [0, -.055, -.03], .008, bm, .007, 8), rod([0, 0, .03], [0, -.055, .03], .009, bm, .007, 8));
            g.add(leg); legs.push(leg);
          });
          speed = .12 + R() * .06; roam = 4;
          break;
        }
        case 'parrot': {
          body.add(blob(.055, .07, .09, bm, 0, .16, .01, 16));
          const wingM = mat(darker(c, .9), { roughness: .95 }), tailM = mat('#3a7a3a', { roughness: .9 });
          [-1, 1].forEach(s => { const wing = blob(.012, .05, .08, wingM, s * .06, .16, .01, 10); wing.rotation.z = s * .15; body.add(wing); });   // 收拢的翅膀
          body.add(blob(.02, .012, .08, tailM, 0, .14, .13, 8), blob(.015, .01, .07, tailM, .02, .13, .15, 8), blob(.015, .01, .07, tailM, -.02, .13, .15, 8));   // 长尾羽
          head = new THREE.Group(); head.position.set(0, .27, -.05);
          head.add(blob(.04, .042, .045, mat('#d94436', { roughness: .9 }), 0, 0, 0, 14));          // 红头
          const bk1 = cyl(.002, .016, .035, mat('#8a8a80', { roughness: .5 }), 0, -.015, -.05, 8); bk1.rotation.x = Math.PI / 2.2; head.add(bk1);   // 弯喙
          [-1, 1].forEach(s => head.add(blob(.01, .018, .008, bm, s * .03, .048, .01, 8)));          // 冠羽
          body.add(head); eye(head, .028, .012, -.032, .008);
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * .028, .11, .01); leg.add(rod([0, 0, 0], [0, -.11, 0], .007, mat('#8a8a80', { roughness: .6 }), .006, 6)); g.add(leg); legs.push(leg); });
          speed = .3 + R() * .15; roam = 6;
          break;
        }
        case 'sheep': {
          const hipY = .32, wool = mat('#eceae2', { roughness: 1 }), face = mat('#4a423a', { roughness: .9 });
          body.add(blob(.17, .16, .21, wool, 0, hipY + .02, 0, 22));
          body.add(blob(.13, .12, .16, wool, 0, hipY + .17, 0, 18));               // 背上毛团
          head = new THREE.Group(); head.position.set(0, hipY + .16, -.16);
          head.add(blob(.07, .07, .08, face, 0, 0, 0, 16));
          head.add(rbox(.04, .03, .05, face, 0, -.03, -.06, .01));
          [-1, 1].forEach(s => head.add(blob(.018, .018, .014, face, s * .05, .045, .02, 8)));     // 深色耳
          body.add(head); eye(head, .045, .02, -.05, .012);
          quadLegs(hipY, .08, -.1, .1, .018);
          speed = .3 + R() * .1; roam = 8;
          break;
        }
        case 'goat': {
          const hipY = .35, horn = mat('#a9855c', { roughness: .8 });
          body.add(blob(.15, .14, .19, bm, 0, hipY, 0, 20));
          head = new THREE.Group(); head.position.set(0, hipY + .18, -.15);
          head.add(blob(.065, .065, .075, bm, 0, 0, 0, 16));
          head.add(rbox(.035, .03, .05, bm, 0, -.03, -.055, .01));
          head.add(rbox(.016, .045, .016, mat(darker(c, .85), { roughness: .95 }), 0, -.075, -.03, .004));   // 山羊胡
          [-1, 1].forEach(s => head.add(rod([s * .02, .05, .005], [s * .06, .13, -.03], .011, horn, .007, 6)));   // 后弯角
          body.add(head); eye(head, .042, .018, -.05, .012);
          quadLegs(hipY, .07, -.095, .095, .015);
          speed = .35 + R() * .1; roam = 9;
          break;
        }
        case 'pig': {
          const hipY = .3, snoutM = mat('#d89a92', { roughness: .85 });
          body.add(blob(.19, .17, .24, bm, 0, hipY, 0, 22));
          head = new THREE.Group(); head.position.set(0, hipY + .12, -.17);
          head.add(blob(.11, .1, .1, bm, 0, 0, 0, 18));
          const nose = cyl(.042, .045, .03, snoutM, 0, -.01, -.06, 12); nose.rotation.x = Math.PI / 2; head.add(nose);   // 翘鼻
          [-1, 1].forEach(s => head.add(blob(.006, .006, .006, dark, s * .016, -.01, -.078, 6)));   // 鼻孔
          [-1, 1].forEach(s => { const ear = blob(.03, .04, .008, bm, s * .07, .08, .01, 10); ear.rotation.z = s * .3; ear.rotation.x = -.2; head.add(ear); });
          body.add(head); eye(head, .06, .025, -.05, .012);
          body.add(rod([0, hipY + .08, .22], [0, hipY + .13, .29], .014, bm, .01, 6));             // 卷尾（短棒上翘）
          quadLegs(hipY, .09, -.12, .13, .02);
          speed = .15 + R() * .08; roam = 6;
          break;
        }
        case 'cow': {
          const hipY = .55, black = mat('#3a3835', { roughness: .9 });
          body.add(blob(.3, .26, .36, bm, 0, hipY, 0, 24));
          [[-.16, -.1], [.17, -.05], [-.12, .08], [.13, .14], [-.05, .17]].forEach(([px, pz]) => body.add(blob(.075, .05, .06, black, px, hipY + .06, pz, 12)));   // 黑斑
          body.add(rod([0, hipY + .14, -.14], [0, hipY + .38, -.22], .08, bm, .05, 10));           // 颈
          head = new THREE.Group(); head.position.set(0, hipY + .42, -.24);
          head.add(blob(.13, .12, .14, bm, 0, 0, 0, 18));
          head.add(rbox(.08, .06, .08, mat('#e8c8c0', { roughness: .85 }), 0, -.06, -.09, .01));   // 粉鼻
          [-1, 1].forEach(s => { head.add(blob(.008, .008, .008, dark, s * .028, -.07, -.13, 6)); head.add(blob(.025, .05, .012, bm, s * .12, .06, .02, 8)); head.add(rod([s * .06, .09, 0], [s * .1, .16, -.02], .014, mat('#d8c8a8', { roughness: .7 }), .009, 6)); });   // 鼻孔 / 耳 / 角
          body.add(head); eye(head, .075, .03, -.06, .014);
          quadLegs(hipY, .12, -.16, .18, .03);
          speed = .25 + R() * .1; roam = 10;
          break;
        }
        case 'horse': case 'donkey': {
          const hipY = .62, maneM = mat(darker(c, .65), { roughness: .95 });
          body.add(blob(.24, .22, .32, bm, 0, hipY, 0, 22));
          body.add(rod([0, hipY + .12, -.16], [0, hipY + .44, -.2], .07, bm, .055, 10));           // 颈
          head = new THREE.Group(); head.position.set(0, hipY + .5, -.22);
          head.add(blob(.075, .08, .13, bm, 0, 0, 0, 18));
          head.add(blob(.02, .02, .025, dark, 0, -.045, -.075, 8));                                // 鼻头
          const earL = t === 'donkey' ? .09 : .045;
          [-1, 1].forEach(s => head.add(blob(.02, earL, .012, bm, s * .05, .09, .02, 8)));         // 耳（毛驴更长）
          body.add(head); eye(head, .05, .025, -.06, .013);
          body.add(rod([0, hipY + .3, -.14], [0, hipY + .12, -.24], .022, maneM, .016, 8));        // 额前鬃
          body.add(rod([0, hipY + .1, .16], [0, hipY - .18, .22], .035, maneM, .026, 8));          // 尾
          quadLegs(hipY, .1, -.145, .16, .022);
          speed = (t === 'horse' ? .5 : .4) + R() * .2; roam = t === 'horse' ? 14 : 12;
          break;
        }
        case 'raccoon': {
          const hipY = .22, ring = mat('#3a352f', { roughness: .95 });
          body.add(blob(.14, .13, .18, bm, 0, hipY, 0, 20));
          body.add(blob(.05, .05, .08, bm, 0, hipY + .05, .18, 12), blob(.048, .048, .075, ring, 0, hipY + .07, .23, 12), blob(.042, .042, .07, bm, 0, hipY + .1, .28, 12), blob(.036, .036, .06, ring, 0, hipY + .14, .31, 12));   // 环纹尾
          head = new THREE.Group(); head.position.set(0, hipY + .16, -.13);
          head.add(blob(.08, .075, .085, bm, 0, 0, 0, 16));
          head.add(rbox(.05, .035, .05, mat('#f2ede4', { roughness: .9 }), 0, -.028, -.05, .01));  // 白吻
          head.add(blob(.014, .014, .018, dark, 0, -.03, -.08, 8));                                // 鼻
          [-1, 1].forEach(s => head.add(blob(.024, .02, .012, ring, s * .04, .02, -.05, 8)));      // 黑眼罩
          body.add(head); eye(head, .04, .02, -.05, .011);
          quadLegs(hipY, .07, -.09, .1, .016);
          speed = .4 + R() * .15; roam = 10;
          break;
        }
        case 'frog': {
          body.add(blob(.07, .05, .08, bm, 0, .055, 0, 16));
          head = new THREE.Group(); head.position.set(0, .08, -.05);
          head.add(blob(.05, .04, .05, bm, 0, 0, 0, 14));
          [-1, 1].forEach(s => head.add(blob(.02, .022, .02, bm, s * .03, .032, -.005, 10)));      // 眼包
          body.add(head); eye(head, .03, .045, -.008, .01);
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * .04, .04, -.03); leg.add(rod([0, 0, 0], [0, -.04, 0], .006, bm, .005, 6)); g.add(leg); legs.push(leg); });   // 前小爪
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * .055, .05, .05); leg.add(blob(.035, .045, .04, bm, 0, -.01, 0, 10), rbox(.028, .014, .06, bm, 0, -.045, .01, .004)); g.add(leg); legs.push(leg); });   // 后蹬腿
          speed = .3 + R() * .15; roam = 5;
          break;
        }
        case 'kangaroo': {
          body.add(blob(.13, .17, .11, bm, 0, .3, .08, 18));                       // 后躯
          body.add(blob(.08, .1, .09, bm, 0, .48, -.04, 16));                      // 前躯上抬
          head = new THREE.Group(); head.position.set(0, .62, -.12);
          head.add(blob(.06, .06, .07, bm, 0, 0, 0, 16));
          head.add(rbox(.03, .02, .045, bm, 0, -.03, -.05, .008));
          [-1, 1].forEach(s => head.add(blob(.016, .042, .01, bm, s * .042, .055, .02, 8)));       // 立耳
          body.add(head); eye(head, .036, .015, -.045, .011);
          body.add(rod([0, .18, .18], [0, .05, .3], .04, bm, .03, 10));            // 粗尾撑地
          [-1, 1].forEach(s => body.add(blob(.02, .02, .025, bm, s * .055, .42, -.09, 8)));        // 小前爪
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * .09, .3, .07); leg.add(blob(.06, .12, .06, bm, 0, -.04, 0, 12), rbox(.05, .02, .12, bm, 0, -.11, .01, .006)); g.add(leg); legs.push(leg); });   // 大后腿
          speed = .5 + R() * .2; roam = 12;
          break;
        }
        case 'ostrich': {
          body.add(blob(.11, .1, .14, bm, 0, .55, .02, 18));
          const neckM = mat('#d8a878', { roughness: .85 });
          body.add(rod([0, .58, -.1], [0, 1.02, -.16], .035, neckM, .022, 8));     // 长颈
          head = new THREE.Group(); head.position.set(0, 1.04, -.17);
          head.add(blob(.05, .05, .06, bm, 0, 0, 0, 14));
          const bk2 = cyl(.002, .02, .05, mat('#c08050', { roughness: .6 }), 0, -.008, -.05, 8); bk2.rotation.x = Math.PI / 2; head.add(bk2);
          body.add(head); eye(head, .03, .015, -.03, .009);
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * .05, .5, .02); leg.add(rod([0, 0, 0], [0, -.48, 0], .02, neckM, .014, 8), rbox(.05, .02, .09, neckM, 0, -.49, -.01, .005)); g.add(leg); legs.push(leg); });
          speed = .55 + R() * .2; roam = 14;
          break;
        }
        case 'penguin': {
          body.add(blob(.075, .13, .085, bm, 0, .15, 0, 18));
          body.add(blob(.06, .11, .05, mat('#f2f0ea', { roughness: .9 }), 0, .14, -.04, 14));      // 白肚
          [-1, 1].forEach(s => { const flip = blob(.012, .06, .04, bm, s * .08, .15, 0, 10); flip.rotation.z = s * .2; body.add(flip); });   // 鳍
          head = new THREE.Group(); head.position.set(0, .3, -.01);
          head.add(blob(.055, .05, .055, bm, 0, 0, 0, 16));
          const bk3 = cyl(.003, .012, .035, mat('#d97a3a', { roughness: .6 }), 0, -.01, -.05, 8); bk3.rotation.x = Math.PI / 2; head.add(bk3);
          body.add(head); eye(head, .028, .012, -.036, .008);
          [-1, 1].forEach(s => { const leg = new THREE.Group(); leg.position.set(s * .035, .028, .01); leg.add(rbox(.02, .02, .05, mat('#d97a3a', { roughness: .7 }), 0, -.01, 0, .005)); g.add(leg); legs.push(leg); });
          speed = .18 + R() * .08; roam = 5;
          break;
        }
        case 'snake': {
          body.add(blob(.05, .04, .3, bm, 0, .035, .02, 14));
          body.add(blob(.04, .032, .1, bm, 0, .04, .19, 12));                      // 尾段收窄
          head = new THREE.Group(); head.position.set(0, .05, -.2);
          head.add(blob(.045, .035, .07, bm, 0, 0, .01, 12));
          head.add(blob(.012, .01, .02, dark, 0, -.01, -.04, 8));
          body.add(head); eye(head, .028, .02, -.02, .008);
          speed = .15 + R() * .1; roam = 6;
          break;
        }
      }
      const homeX = wx(f.cx), homeZ = wz(f.cy);
      g.userData.poultry = {
        phase: R() * Math.PI * 2, body, head, legs, homeX, homeZ, roam,
        speed, heading: R() * Math.PI * 2, hop: t === 'rabbit' || t === 'petrabbit' || t === 'frog' || t === 'kangaroo', slither: t === 'snake',
        tx: homeX, tz: homeZ, wait: R() * 1.2, gait: 0
      };
    }
    function buildFurniture(f) {
      const g = new THREE.Group(), w = M(f.w), d = M(f.d), c = f.color || '#ddd', bz = -d / 2, R = rng(Math.round(f.w * 7 + f.d * 13 + f.cx + f.cy));
      switch (f.type) {
        case 'bed': {
          const fr = woodM('#8d7258'), fab = fabric(c), fh = .3, mt = .22, top = fh + mt, n = Math.max(3, Math.round(w / .28)), sw = (w - .04) / n;
          g.add(box(w - .12, .06, d - .14, '#4a3e33', 0, 0, .03), rbox(w, fh - .06, d - .08, fr, 0, .06, .04, .015));        // 内缩踢脚 + 床箱
          g.add(rbox(w, 1.08, .06, fr, 0, 0, bz + .03, .012));                                                                 // 床头板
          for (let i = 0; i < n; i++) g.add(rbox(sw - .006, .62, .06, fabric(darker(c, .8)), -w / 2 + .02 + sw * (i + .5), .42, bz + .08, .025));   // 竖向软包
          const md = d - .13, dd = md * .66, dz = d / 2 - .015 - dd / 2;
          g.add(rbox(w - .06, mt, md, '#f6f3ee', 0, fh, bz + .11 + md / 2, .07));                                              // 床垫
          g.add(rbox(w + .02, .27, dd, fab, 0, top - .2, dz, .04), rbox(w + .024, .06, .22, fabric('#fbfaf7'), 0, top + .025, dz - dd / 2 + .11, .025));   // 被子 + 翻边
          g.add(rbox(w + .05, .285, .42, fabric(darker(c, .62)), 0, top - .205, d / 2 - .35, .03));                               // 床尾巾
          const np = w >= 1.3 ? 2 : 1, pw = (w - .16 - (np - 1) * .06) / np;
          for (let i = 0; i < np; i++) {
            const x = -w / 2 + .08 + pw / 2 + i * (pw + .06);
            g.add(rot(rbox(pw, .15, .42, fabric('#ffffff'), x, top - .01, bz + .34, .07), -.28), rot(rbox(pw * .62, .3, .1, fabric(i ? '#efe7da' : darker(c, .7)), x, top, bz + .54, .045), -.3));
          }
          break;
        }
        case 'sofa': case 'armchair': {
          const fab = fabric(c), dk = fabric(darker(c, .88)), a = Math.min(.18, w * .14), n = f.type === 'armchair' ? 1 : (w > 2.2 ? 3 : 2), cw = (w - 2 * a) / n, bd = Math.min(.2, d * .24), lh = .12, sd = d - bd - .02;
          legs(g, w, d, lh, woodM('#3a3027'), .07, .018);
          g.add(rbox(w, .16, d, dk, 0, lh, 0, .03), rbox(w, .73, bd, dk, 0, lh, bz + bd / 2, .06));
          [-1, 1].forEach(s => g.add(rbox(a, .5, d, dk, s * (w / 2 - a / 2), lh, 0, .07)));
          for (let i = 0; i < n; i++) {
            const x = -w / 2 + a + cw / 2 + i * cw;
            g.add(rbox(cw - .012, .15, sd, fab, x, lh + .16, bz + bd + sd / 2, .055), rot(rbox(cw - .03, .44, .16, fab, x, lh + .3, bz + bd + .08, .07), -.16));
          }
          if (n > 1) [-1, 1].forEach(s => g.add(rot(rbox(.42, .42, .12, fabric(s < 0 ? '#ece5d8' : darker(c, .7)), s * (w / 2 - a - .26), lh + .32, bz + bd + .22, .06), -.3, s * -.25)));
          else g.add(rot(rbox(.4, .26, .1, fabric('#ece5d8'), 0, lh + .33, bz + bd + .2, .05), -.25));
          break;
        }
        case 'cornersofa': {
          const k = Math.min(.95, d * .56, w * .4), b = .2, fab = fabric(c), dk = fabric(darker(c, .88)), lh = .1, sw = (w - b - .2) / 2;
          [[-w / 2 + .07, bz + .07], [w / 2 - .07, bz + .07], [w / 2 - .07, bz + k - .07], [-w / 2 + .07, d / 2 - .07], [-w / 2 + k - .07, d / 2 - .07], [-w / 2 + k - .07, bz + k - .07]]
            .forEach(([x, z]) => g.add(rod([x, 0, z], [x, lh, z], .012, woodM('#3a3027'), .018)));
          g.add(rbox(w, .18, k, dk, 0, lh, bz + k / 2, .03), rbox(k, .18, d - k + .02, dk, -w / 2 + k / 2, lh, bz + k + (d - k) / 2 - .01, .03));
          g.add(rbox(w, .72, b, dk, 0, lh, bz + b / 2, .06), rbox(b, .72, d, dk, -w / 2 + b / 2, lh, 0, .06), rbox(.2, .5, k, dk, w / 2 - .1, lh, bz + k / 2, .07), rbox(k, .5, .2, dk, -w / 2 + k / 2, lh, d / 2 - .1, .07));
          for (let i = 0; i < 2; i++) {
            const x = -w / 2 + b + sw / 2 + i * sw;
            g.add(rbox(sw - .012, .15, k - b - .02, fab, x, lh + .18, bz + b + (k - b) / 2, .055), rot(rbox(sw - .04, .42, .16, fab, x, lh + .3, bz + b + .07, .07), -.16));
          }
          g.add(rbox(k - b - .02, .15, d - k - .22, fab, -w / 2 + b + (k - b) / 2, lh + .18, bz + k + (d - k - .2) / 2, .055));
          const L = d - .2 - b - .18, nl = Math.max(1, Math.round(L / .75));
          for (let i = 0; i < nl; i++) g.add(rot(rbox(.16, .42, L / nl - .03, fab, -w / 2 + b + .07, lh + .3, bz + b + .18 + L / nl * (i + .5), .07), 0, 0, .16));
          g.add(rot(rbox(.42, .42, .12, fabric('#ece5d8'), -w / 2 + b + .3, lh + .34, bz + b + .24, .06), -.35, .6), rot(rbox(.4, .4, .12, fabric(darker(c, .7)), w / 2 - .5, lh + .34, bz + b + .2, .06), -.3, -.25));
          break;
        }
        case 'nightstand': {
          const wm = woodM(c);
          legs(g, w, d, .1, woodM('#5a4a3b'), .04, .014);
          g.add(rbox(w, .4, d - .02, wm, 0, .1, -.01, .012));
          fronts(g, -w / 2 + .02, .12, w - .04, .36, d / 2 - .02, 1, 2, wm, 'bar');
          tableLamp(g, -w * .12, .5, -d * .12);
          g.add(box(.16, .025, .22, '#2f5d62', w * .24, .5, .04), box(.14, .02, .2, '#e6dccd', w * .24, .525, .04));
          break;
        }
        case 'wardrobe': case 'cabinet': case 'shoecab': {
          const cm = mat(c, { roughness: .55 }), fz = d / 2 - .02;
          if (f.type === 'wardrobe') {
            const h = 2.2, n = Math.max(1, Math.round(w / .5));
            g.add(box(w - .02, .08, d - .06, '#4a4641', 0, 0, -.03), box(w, h - .08, d - .02, cm, 0, .08, -.01));
            fronts(g, -w / 2, .08, w, h - .1, fz, n, 1, cm, 'bar', 1.05);
            g.add(box(w, .02, d - .02, darker(c, .9), 0, h - .02, -.01));
          } else if (f.type === 'shoecab') {
            const h = 1.0, y0 = .16, n = Math.max(1, Math.round(w / .45));
            g.add(box(w, h - y0, d - .02, cm, 0, y0, -.01), box(w - .04, .01, .03, glowMat('#fff7e6', '#ffe9c4', .8), 0, y0 - .01, fz - .06));   // 悬空 + 底部灯带
            fronts(g, -w / 2, y0, w, h - y0, fz, n, 1, cm, 'edge');
            g.add(rbox(w + .01, .025, d, woodM(darker(c, .8)), 0, h, 0, .006));
            g.add(rbox(.22, .015, .14, woodM('#6b543f'), -w * .25, h + .025, 0, .006));
            vase(g, w * .28, h + .025, -.03, .05, .2, '#d8cfc2', R);
          } else {
            const h = .85, n = Math.max(1, Math.round(w / .5));
            legs(g, w, d, .1, woodM('#3a3027'), .05, .016);
            g.add(box(w, h - .13, d - .02, cm, 0, .1, -.01));
            fronts(g, -w / 2, .62, w, .2, fz, n, 1, cm, 'bar');
            fronts(g, -w / 2, .1, w, .52, fz, n, 1, cm, 'bar', .52);
            g.add(rbox(w + .02, .03, d + .01, woodM(darker(c, .78)), 0, h - .03, 0, .008));
            vase(g, w * .3, h, 0, .07, .24, '#e9e2d6', R);
            g.add(rot(box(.3, .38, .02, woodM('#3a3027'), -w * .25, h, bz + .06), -.12), rot(box(.25, .33, .005, '#d9cfbf', -w * .25, h + .03, bz + .075), -.12));   // 靠墙画框
            g.add(lathe([[0, 0], [.05, 0], [.12, .06], [.13, .07]], mat('#b8a58c', { roughness: .5, side: THREE.DoubleSide }), 0, h, .02, 32));
            for (let k = 0; k < 3; k++) g.add(blob(.035, .035, .035, ['#d98c4a', '#c9ad4f', '#b5463a'][k], Math.cos(k * 2.1) * .04, h + .045, .02 + Math.sin(k * 2.1) * .04, 14));
          }
          break;
        }
        case 'dresser': {
          const wm = woodM(c), r = Math.min(.34, w * .3);
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => g.add(rod([a * (w / 2 - .04), 0, b * (d / 2 - .04)], [a * (w / 2 - .05), .58, b * (d / 2 - .05)], .012, wm, .02)));
          g.add(box(w - .04, .14, d - .04, wm, 0, .58), rbox(w, .03, d, wm, 0, .72, 0, .008));
          fronts(g, -w / 2 + .03, .585, w - .06, .13, d / 2 - .02, 2, 1, wm, 'knob');
          const mr = new THREE.Mesh(new THREE.TorusGeometry(r, .018, 12, 64), woodM(darker(c, .7))); mr.position.set(0, .77 + r, bz + .04); sh(mr);
          const mg = new THREE.Mesh(new THREE.CircleGeometry(r, 64), mirror()); mg.position.set(0, .77 + r, bz + .035);
          g.add(mr, mg, box(.08, .03, .06, woodM(darker(c, .7)), 0, .75, bz + .04));
          [['#e7c9b5', .03, .09], ['#b9d0d8', .025, .12], ['#f0e3cf', .02, .07]].forEach(([cc, rr, hh], i) => g.add(cyl(rr, rr, hh, mat(cc, { roughness: .15, transparent: true, opacity: .8 }), w * .25 + i * .06, .75, .02)));
          g.add(rbox(.16, .06, .1, woodM('#6b543f'), -w * .28, .75, .03, .01));
          const sz = d / 2 + .25;
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => g.add(rod([a * .13, 0, sz + b * .13], [a * .12, .4, sz + b * .12], .01, wm, .014)));
          g.add(rbox(.34, .08, .34, fabric('#e8ddd0'), 0, .4, sz, .035));
          break;
        }
        case 'desk': {
          const tm = woodM(c), bm = blackMetal();
          g.add(rbox(w, .025, d, tm, 0, .72, 0, .006));
          [-1, 1].forEach(s => {
            const x = s * (w / 2 - .06);
            g.add(box(.03, .72, .03, bm, x, 0, d / 2 - .06), box(.03, .72, .03, bm, x, 0, bz + .06), box(.03, .03, d - .1, bm, x, 0, 0), box(.03, .03, d - .1, bm, x, .69, 0));
          });
          g.add(box(w - .12, .04, .015, bm, 0, .66, bz + .06), box(.4, .09, d - .12, tm, w / 2 - .32, .63, 0));
          pull(g, .16, false, w / 2 - .32, .675, d / 2 - .06);
          const my = .745, mz = bz + .15;
          g.add(rbox(.22, .012, .16, bm, 0, my, mz, .004), rod([0, my, mz - .02], [0, my + .2, mz - .03], .012, bm));
          g.add(rbox(.62, .37, .02, '#1d1d1f', 0, my + .12, mz - .04, .006), box(.6, .33, .002, screenMat('#27405c'), 0, my + .15, mz - .029));
          g.add(rbox(.42, .015, .13, '#e8e8ea', 0, my, .06, .004), rbox(.4, .004, .11, '#d2d2d6', 0, my + .014, .06, .002), blob(.03, .015, .05, '#e8e8ea', .3, my + .012, .07, 16));
          const lx = -w / 2 + .15, lz = bz + .12;
          g.add(cyl(.07, .075, .02, bm, lx, my, lz, 28), tube([[lx, my + .02, lz], [lx, my + .3, lz + .03], [lx + .12, my + .42, lz + .1]], .008, bm));
          const hd = cyl(.02, .06, .1, bm, lx + .14, my + .34, lz + .12, 24); hd.rotation.x = .5; g.add(hd);
          g.add(cyl(.04, .038, .09, ceramic({ roughness: .3 }), w / 2 - .15, my, .05, 20), rbox(.2, .015, .28, '#3b5566', -w / 2 + .3, my, .1, .004));
          break;
        }
        case 'chair': {
          const lw = woodM('#6b543f'), fab = fabric(c), sy = .44;
          [[-1, 1], [1, 1]].forEach(([s]) => g.add(rod([s * (w / 2 - .04), 0, d / 2 - .05], [s * (w / 2 - .05), sy, d / 2 - .07], .012, lw, .018)));
          [-1, 1].forEach(s => g.add(rod([s * (w / 2 - .04), 0, bz + .03], [s * (w / 2 - .05), .86, bz + .07], .012, lw, .018)));
          g.add(box(w - .08, .025, .02, lw, 0, .15, d / 2 - .06), box(w - .08, .025, .02, lw, 0, .15, bz + .05));
          [-1, 1].forEach(s => g.add(box(.02, .025, d - .12, lw, s * (w / 2 - .045), .18, 0)));
          g.add(box(w - .06, .04, d - .1, lw, 0, sy - .03, 0), rbox(w - .04, .05, d - .08, fab, 0, sy, .005, .022));
          g.add(rot(rbox(w - .08, .15, .025, lw, 0, .66, bz + .065, .012), -.12), rot(box(w - .08, .025, .02, lw, 0, .52, bz + .055), -.12));
          break;
        }
        case 'bookshelf': {
          const h = 1.8, t = .022, ns = 5, wm = woodM(c), sh0 = (h - .06 - t) / ns, cols = ['#b88a6a', '#6f8f8a', '#d9c08c', '#9aa58c', '#a8675e', '#e6dccd', '#7d8ea3', '#c9bfae'];
          g.add(box(w, h, .012, woodM(darker(c, .85)), 0, 0, bz + .006), box(t, h, d, wm, -w / 2 + t / 2), box(t, h, d, wm, w / 2 - t / 2), box(w - 2 * t, .06, d - .03, wm, 0, 0, .0));
          for (let s = 0; s <= ns; s++) {
            const y = s < ns ? .06 + s * sh0 : h - t; g.add(box(w - 2 * t, t, d - .012, wm, 0, y, .006));
            if (s === ns) break;
            const yb = y + t, end = w / 2 - t - .01; let x = -w / 2 + t + .01, deco = R() < .55 ? x + R() * (w - .45) : 99;
            while (x < end - .03) {
              if (x >= deco) {
                deco = 99;
                if (R() < .5) vase(g, x + .07, yb, 0, .045, .16, cols[Math.floor(R() * 8)], R, false);
                else for (let k = 0; k < 3; k++) g.add(box(.2 - k * .02, .028, d * .7, mat(cols[Math.floor(R() * 8)], { roughness: .8 }), x + .1, yb + k * .028, .01));
                x += .2; continue;
              }
              if (R() < .07) { x += .03 + R() * .05; continue; }
              const bw = .018 + R() * .03, bh = Math.min(sh0 - t - .03, .17 + R() * .13), bd = d * (.62 + R() * .22);
              if (x + bw > end) break;
              g.add(box(bw, bh, bd, mat(cols[Math.floor(R() * 8)], { roughness: .75 }), x + bw / 2, yb, d / 2 - .015 - bd / 2));
              x += bw + .002;
            }
          }
          break;
        }
        case 'baycushion':
          g.add(rbox(w, .08, d, fabric(c), 0, .45, 0, .03));
          g.add(rot(rbox(w - .1, .34, .14, fabric('#ffffff'), 0, .52, bz + .14, .06), .25), rot(rbox(w - .1, .34, .14, fabric('#f0e6d6'), 0, .52, d / 2 - .14, .06), -.25));
          g.add(rbox(w * .8, .04, .3, fabric(darker(c, .7)), 0, .53, d * .12, .02), rbox(.28, .015, .2, woodM('#8d7258'), 0, .53, -d * .15, .006), cyl(.035, .03, .06, ceramic(), 0, .545, -d * .15, 20));
          break;
        case 'coffeetable': {
          const tm = mat(c, { roughness: .35 }), lw = woodM('#3a3027');
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => g.add(rod([a * (w / 2 - .05), 0, b * (d / 2 - .05)], [a * (w / 2 - .07), .365, b * (d / 2 - .07)], .012, lw, .02)));
          g.add(rbox(w, .035, d, tm, 0, .365, 0, .015), rbox(w - .12, .02, d - .12, woodM(darker(c, .85)), 0, .12, 0, .006));
          g.add(box(.3, .03, .22, '#2f5d62', w * .2, .14, 0), box(.26, .025, .19, '#d9b36c', w * .2, .17, .01));
          g.add(rbox(.38, .015, .24, woodM('#6b543f'), -w * .2, .4, 0, .006), box(.22, .025, .16, '#e6dccd', -w * .22, .415, 0));
          g.add(lathe([[0, 0], [.025, 0], [.035, .07], [.034, .08]], ceramic({ side: THREE.DoubleSide }), -w * .12, .415, .06, 20));
          vase(g, w * .24, .4, -.05, .055, .18, '#e9e2d6', R);
          break;
        }
        case 'tvstand': {
          const sm = mat(c, { roughness: .5 }), n = Math.max(2, Math.round(w / .6));
          legs(g, w, d, .1, blackMetal(), .08, .012);
          g.add(rbox(w, .4, d - .02, sm, 0, .1, -.01, .01));
          fronts(g, -w / 2 + .005, .105, w - .01, .39, d / 2 - .02, n, 1, sm, 'edge');
          g.add(rbox(1.45, .84, .025, mat('#18181a', { roughness: .4, metalness: .3 }), 0, .95, bz + .03, .004), box(1.43, .81, .002, screenMat(), 0, .962, bz + .0435));
          g.add(rbox(.9, .06, .09, '#2a2a2c', 0, .5, -.02, .02), box(.86, .045, .002, fabric('#3a3a3c'), 0, .507, .026));
          vase(g, w / 2 - .25, .5, 0, .06, .26, '#d8cfc2', R);
          g.add(box(.25, .035, .18, '#a9433b', -w / 2 + .3, .5, 0), box(.22, .03, .16, '#e6dccd', -w / 2 + .3, .535, 0));
          break;
        }
        case 'rug':
          [[w, d, .01, c, 0], [w - .16, d - .16, .002, darker(c, .82), .01], [w - .26, d - .26, .002, lighter(c, .12), .0115]].forEach(([a, b, h, cc, y]) => {
            const r = box(a, h, b, mat(cc, { roughness: 1 }), 0, y + .002); r.castShadow = false; g.add(r);
          });
          break;
        case 'plant': {
          const r = Math.min(w, d) / 2, H = .9 + r * 1.6, pot = mat('#d9d2c5', { roughness: .6 }), lm = [mat('#5f8f4e', { roughness: .6, side: THREE.DoubleSide }), mat('#79a862', { roughness: .6, side: THREE.DoubleSide })];
          g.add(lathe([[0, 0], [r * .4, 0], [r * .44, .02], [r * .54, .36], [r * .57, .4], [r * .52, .4], [r * .5, .37], [0, .37]], pot, 0, 0, 0, 36), cyl(r * .49, r * .49, .005, '#4a3a2c', 0, .368, 0, 28));
          g.add(rod([0, .37, 0], [.02, H * .62, -.01], .016, '#6b5540', .009));
          const N = 20 + Math.round(r * 36), sc = Math.sqrt(r / .25);
          for (let k = 0; k < N; k++) {
            const t = k / N, a = k * 2.399 + R() * .3, len = (.14 + R() * .08) * (1.1 - t * .4) * sc, s0 = .03 + R() * .08 * sc, p = new THREE.Group();
            p.position.set(0, H * (.42 + .58 * t), 0); p.rotation.set(0, -a, .1 + t * .5 + R() * .3, 'YXZ');
            const lf = blob(len / 2, .005, len * .27, lm[k % 2], s0 + len / 2, 0, 0, 16); lf.rotation.z = -.3;
            p.add(box(s0, .005, .005, '#6f8f4a', s0 / 2, 0, 0), lf); g.add(p);
          }
          break;
        }
        case 'chicken': case 'duck': case 'goose':
          poultryModel(g, f, w, d, c, R); break;
        case 'rabbit': case 'squirrel': case 'hedgehog': case 'fox': case 'tortoise': case 'deer': case 'cat': case 'dog': case 'hamster': case 'petrabbit': case 'parrot': case 'sheep': case 'goat': case 'pig': case 'cow': case 'horse': case 'donkey': case 'wolf': case 'raccoon': case 'frog': case 'kangaroo': case 'ostrich': case 'penguin': case 'snake':
          wildAnimalModel(g, f, w, d, c, R); break;
        case 'table': {
          const tm = mat(c, { roughness: .4 }), lw = woodM(darker(c, .55)), ns = Math.max(1, Math.round(w / .62)), top = .75;
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => g.add(rod([a * (w / 2 - .08), 0, b * (d / 2 - .08)], [a * (w / 2 - .1), .715, b * (d / 2 - .1)], .016, lw, .026)));
          g.add(rbox(w, .035, d, tm, 0, .715, 0, .012), box(w - .22, .07, d - .22, lw, 0, .645));
          g.add(box(w * .7, .003, .32, fabric('#b9a58c'), 0, top, 0));
          for (let i = 0; i < ns; i++) [-1, 1].forEach(s => {
            const x = -w / 2 + w / ns * (i + .5), z = s * (d / 2 - .17);
            g.add(box(.38, .003, .28, fabric('#e7dfd1'), x, top, z)); plate(g, .12, x, top + .003, z);
            g.add(cyl(.03, .026, .1, mat('#dfeef3', { transparent: true, opacity: .35, roughness: .05 }), x + .15, top + .003, z - s * .1, 16));
          });
          vase(g, 0, top + .003, 0, .06, .2, '#e9e2d6', R);
          break;
        }
        case 'roundtable': {
          const b = Math.min(.25, w * .3), lw = woodM('#4a3e33'), top = .75;
          g.add(lathe([[b, 0], [b, .015], [b * .8, .035], [.06, .12], [.045, .35], [.05, .6], [.12, .69], [.18, .715]], lw, 0, 0, 0, 40), cyl(w / 2, w / 2, .035, mat(c, { roughness: .4 }), 0, .715, 0, 64));
          for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + .4, rr = w / 2 - .17; plate(g, .11, Math.cos(a) * rr, top, Math.sin(a) * rr); }
          vase(g, 0, top, 0, .05, .18, '#e9e2d6', R);
          break;
        }
        case 'counter': {
          const cm = mat(c, { roughness: .45 }), stone = mat('#dcd7cf', { roughness: .22 }), n = Math.max(1, Math.round(w / .6)), fz = d / 2 - .04;
          g.add(box(w - .01, .1, d - .1, '#4a4641', 0, 0, -.05), box(w, .72, d - .04, cm, 0, .1, -.02));
          fronts(g, -w / 2, .64, w, .18, fz, n, 1, cm, 'bar'); fronts(g, -w / 2, .1, w, .54, fz, n, 1, cm, 'bar', .56);
          g.add(rbox(w + .01, .04, d, stone, 0, .82, 0, .004), box(w, .62, .01, mat('#efece6', { roughness: .3 }), 0, .86, bz + .005));
          g.add(box(w, .7, .33, cm, 0, 1.48, bz + .165)); fronts(g, -w / 2, 1.48, w, .7, bz + .33, n, 1, cm, 'bar', 1.56);
          g.add(box(w - .04, .01, .02, glowMat('#fff7e6', '#ffe9c4', .8), 0, 1.47, bz + .29));
          if (w >= .8) {
            g.add(rbox(.36, .018, .25, woodM('#c9a27a'), -w / 2 + .3, .86, .0, .005));
            [.07, .06, .05].forEach((r, i) => g.add(cyl(r, r, .16 - i * .03, mat(['#e9e2d6', '#d6cfc3', '#bfb6a8'][i], { roughness: .4 }), w / 2 - .15 - i * .15, .86, bz + .1, 24)));
            g.add(cyl(.05, .045, .14, ceramic({ roughness: .3 }), w / 2 - .6, .86, bz + .1, 20));
            for (let k = 0; k < 4; k++) g.add(rod([w / 2 - .6, .9, bz + .1], [w / 2 - .6 + (k - 1.5) * .018, 1.1, bz + .1 + (k % 2 - .5) * .02], .005, woodM('#8d7258'), .006, 6));
          }
          break;
        }
        case 'stove': {
          const sm = mat('#b9bec3', { metalness: .8, roughness: .3 });
          g.add(rbox(w, .012, d, mat('#0d0d0e', { roughness: .06, metalness: .3 }), 0, .862, 0, .004));
          (w / d > 1.4 ? [[-w / 4, 0], [w / 4, 0]] : [[-w / 4, -d / 4], [w / 4, -d / 4], [-w / 4, d / 4], [w / 4, d / 4]]).forEach(([x, z]) => {
            g.add(cyl(.085, .09, .008, '#2b2b2b', x, .874, z, 32), cyl(.045, .05, .014, mat('#6b5a45', { metalness: .7, roughness: .35 }), x, .874, z, 28), cyl(.028, .028, .022, '#1a1a1a', x, .874, z, 20));
            for (let k = 0; k < 5; k++) { const a = k * Math.PI * 2 / 5; g.add(rot(box(.07, .014, .012, '#1c1c1c', x + Math.cos(a) * .1, .874, z + Math.sin(a) * .1), 0, -a)); }
            g.add(cyl(.02, .022, .018, '#222', x, .874, d / 2 - .04, 20));
          });
          g.add(rbox(w, .06, .5, sm, 0, 1.55, bz + .25, .01), box(.3, .72, .26, sm, 0, 1.61, bz + .13));
          g.add(rot(box(w - .02, .3, .008, mat('#15181b', { roughness: .05, metalness: .5 }), 0, 1.58, bz + .38), -.9), box(.16, .012, .003, mat('#101214', { emissive: '#6fd0ff', emissiveIntensity: .6 }), 0, 1.575, bz + .502));
          break;
        }
        case 'ksink': {
          const st = mat('#c7ccd1', { metalness: .85, roughness: .28 }), inner = mat('#9aa1a8', { metalness: .8, roughness: .35 }), two = w >= .75, bw = two ? w * .42 : w * .7, bd = d * .66;
          g.add(box(w, .008, d, st, 0, .862, 0));
          (two ? [-w * .23, w * .23] : [0]).forEach(x => g.add(shell(bw, bd, .02, .015, .04, st, x, .862, .03), box(bw - .03, .002, bd - .03, inner, x, .87, .03), cyl(.03, .03, .003, chrome(), x, .872, .03, 20)));
          const fx = two ? 0 : w * .3, cm = chrome();
          g.add(cyl(.025, .028, .03, cm, fx, .87, bz + .06, 20), tube([[fx, .9, bz + .06], [fx, 1.12, bz + .06], [fx, 1.17, bz + .1], [fx, 1.14, bz + .18], [fx, 1.08, bz + .2]], .012, cm));
          g.add(rot(box(.012, .012, .09, cm, fx + .035, .98, bz + .09), -.3));
          break;
        }
        case 'fridge': {
          const fm = mat(c, { metalness: .45, roughness: .28 }), h = 1.8, fz = d / 2 - .05;
          g.add(box(w - .02, .06, d - .06, '#2a2c2e', 0, 0, -.03), rbox(w, h - .06, d - .05, fm, 0, .06, -.025, .02), box(w - .01, h - .07, .003, '#2a2c2e', 0, .065, fz + .0015));
          if (w > .85) {
            [-1, 1].forEach(s => { g.add(rbox(w / 2 - .004, h - .08, .04, fm, s * w / 4, .07, fz + .023, .012)); pull(g, .8, true, s * .035, 1.05, fz + .043); });
            g.add(box(.1, .14, .003, screenMat('#2a6f8f'), -w / 4, 1.25, fz + .044));
          } else {
            g.add(rbox(w - .006, 1.06, .04, fm, 0, .72, fz + .023, .012), rbox(w - .006, .64, .04, fm, 0, .07, fz + .023, .012));
            pull(g, .5, true, -w / 2 + .06, 1.05, fz + .043); pull(g, w * .5, false, 0, .64, fz + .043);
            g.add(box(.08, .1, .003, screenMat('#2a6f8f'), w * .22, 1.4, fz + .044));
          }
          break;
        }
        case 'toilet': {
          const cer = ceramic(), Rb = w * .45, zc = bz + d * .62, kz = (d * .37) / Rb, cm = chrome();
          g.add(rbox(w * .88, .4, d * .24, cer, 0, .36, bz + d * .12, .04), rbox(w * .92, .03, d * .27, cer, 0, .76, bz + d * .135, .012), cyl(.022, .022, .006, cm, 0, .79, bz + d * .135, 20));
          const ped = lathe([[0, 0], [Rb * .62, 0], [Rb * .66, .02], [Rb * .56, .12], [Rb * .62, .22], [Rb * .92, .33], [Rb, .37]], cer, 0, 0, zc, 40);
          const seat = cyl(Rb * 1.01, Rb * 1.01, .022, mat('#f4f4f2', { roughness: .2 }), 0, .37, zc, 40), lid = cyl(Rb * .97, Rb * .99, .02, mat('#f4f4f2', { roughness: .2 }), 0, .392, zc, 40);
          ped.scale.z = seat.scale.z = lid.scale.z = kz; g.add(ped, seat, lid);
          [-1, 1].forEach(s => g.add(box(.03, .02, .03, cm, s * w * .18, .39, zc - Rb * kz - .005)));
          break;
        }
        case 'vanity': {
          const vm = mat(c, { roughness: .5 }), stone = mat('#fafafa', { roughness: .18 }), nb = w >= 1.1 ? 2 : 1, cd = d - .04, cm = chrome();
          g.add(rbox(w, .45, cd, vm, 0, .33, bz + cd / 2, .008));
          fronts(g, -w / 2 + .005, .335, w - .01, .44, d / 2 - .04, nb, 2, vm, 'edge');
          g.add(rbox(w, .03, d, stone, 0, .78, 0, .006));
          const rb = Math.min(.19, w / nb * .36);
          for (let i = 0; i < nb; i++) {
            const x = nb === 1 ? 0 : (i ? w / 4 : -w / 4);
            g.add(lathe([[0, 0], [rb * .55, 0], [rb * .85, .03], [rb, .1], [rb * .97, .12]], ceramic({ side: THREE.DoubleSide }), x, .81, .03, 40), cyl(.018, .018, .003, cm, x, .812, .03, 16));
            g.add(cyl(.02, .022, .02, cm, x, .81, bz + .06, 16), tube([[x, .83, bz + .06], [x, 1.03, bz + .06], [x, 1.07, bz + .11], [x, 1.03, bz + .15]], .01, cm), rot(box(.01, .01, .06, cm, x, 1.05, bz + .04), .4));
          }
          const mw = Math.min(w * .9, nb * .7);
          g.add(rbox(mw + .02, .82, .02, glowMat('#fff7e6', '#ffe9c4', .9), 0, 1.14, bz + .01, .01), box(mw, .8, .01, mirror(), 0, 1.15, bz + .025));
          g.add(cyl(.028, .028, .12, mat('#c8b8a6', { roughness: .3 }), w / 2 - .08, .81, bz + .1, 16), rbox(.18, .03, .12, fabric('#e9e2d6'), -w / 2 + .12, .81, .05, .012));
          break;
        }
        case 'shower': {
          const cm = chrome(), x = -w / 4;
          g.add(rbox(w, .05, d, mat('#f4f4f2', { roughness: .3 }), 0, 0, 0, .01), box(w * .6, .003, .05, mat('#9aa1a8', { metalness: .8, roughness: .3 }), 0, .05, bz + .08));
          [[w, .01, 0, d / 2 - .005], [.01, d, w / 2 - .005, 0]].forEach(([gw, gd, px, pz]) => { const p = box(gw, 1.95, gd, glassMat, px, .05, pz); p.castShadow = false; g.add(p); });
          g.add(box(.02, 1.95, .02, frameMat, w / 2 - .01, .05, d / 2 - .01), box(.02, 1.95, .03, frameMat, -w / 2 + .01, .05, d / 2 - .005), box(.03, 1.95, .02, frameMat, w / 2 - .005, .05, bz + .01));
          g.add(box(w, .015, .02, frameMat, 0, 1.985, d / 2 - .005), box(.02, .015, d, frameMat, w / 2 - .005, 1.985, 0));
          g.add(rbox(.14, .1, .04, cm, x, 1.0, bz + .02, .01), rod([x, 1.1, bz + .03], [x, 1.95, bz + .03], .012, cm));
          g.add(tube([[x, 1.95, bz + .03], [x, 2.02, bz + .06], [x, 2.03, bz + .22]], .01, cm), rbox(.24, .012, .24, cm, x, 2.02, bz + .25, .004));
          g.add(rot(cyl(.015, .02, .2, cm, x + .1, 1.25, bz + .05, 16), .25), blob(.03, .012, .03, cm, x + .1, 1.47, bz + .08, 16));
          g.add(box(.26, .012, .1, ceramic(), w / 2 - .2, 1.2, bz + .05));
          [['#e6dccd', .03, .18], ['#2f5d62', .025, .15], ['#f4f4f2', .028, .12]].forEach(([cc, r, hh], i) => g.add(cyl(r, r, hh, mat(cc, { roughness: .3 }), w / 2 - .28 + i * .07, 1.212, bz + .05, 16)));
          break;
        }
        case 'bathtub': {
          const cer = ceramic(), h = .56, t = .07, cm = chrome();
          g.add(shell(w, d, h, t, .14, cer), box(w - .1, .12, d - .1, cer, 0, 0, 0), box(w - 2 * t + .004, .004, d - 2 * t + .004, mat('#bfe0ea', { roughness: .03, transparent: true, opacity: .6 }), 0, .4, 0));
          const fx = w / 2 - t / 2;
          g.add(tube([[fx, h - .02, 0], [fx, h + .1, 0], [fx - .06, h + .13, 0], [fx - .13, h + .09, 0]], .014, cm));
          [-1, 1].forEach(s => g.add(cyl(.02, .02, .04, cm, fx, h, s * .1, 16)));
          g.add(rot(rbox(.08, .16, .3, cer, -w / 2 + t + .06, h - .12, 0, .04), 0, 0, -.5), rbox(.22, .05, .16, fabric('#e9e2d6'), fx - .05, h, d / 2 - .1, .02));
          break;
        }
        case 'washer': case 'dryer': {
          const bm = mat(c, { roughness: .35 }), R0 = Math.min(w, d) * .25, fz = d / 2 - .02;
          g.add(box(w - .02, .04, d - .04, '#8f969b', 0, 0, -.02), rbox(w, .81, d - .02, bm, 0, .04, -.01, .025));
          g.add(box(w - .04, .1, .006, lighter(c, .3), 0, .72, fz + .003), rbox(.18, .07, .01, bm, -w / 2 + .12, .735, fz + .006, .004));
          g.add(box(.12, .035, .003, screenMat('#1f6f6a'), w * .14, .745, fz + .007));
          const kn = cyl(.03, .03, .02, chrome(), -w * .02, .75, fz + .016, 28); kn.rotation.x = Math.PI / 2; g.add(kn);
          const dr = new THREE.Mesh(new THREE.CircleGeometry(R0, 40), mat('#1b1f22', { roughness: .6 })); dr.position.set(0, .4, fz + .004); g.add(dr);
          const rg = new THREE.Mesh(new THREE.TorusGeometry(R0 + .02, .022, 14, 48), mat('#c7cfd5', { metalness: .7, roughness: .25 })); rg.position.set(0, .4, fz + .016); sh(rg); g.add(rg);
          const Rs = R0 * 1.42, cap = new THREE.Mesh(new THREE.SphereGeometry(Rs, 32, 12, 0, Math.PI * 2, 0, .78), mat(f.type === 'dryer' ? '#4a4038' : '#26343d', { roughness: .04, metalness: .2, transparent: true, opacity: .8 }));
          cap.rotation.x = Math.PI / 2; cap.position.set(0, .4, fz + .012 - Rs * Math.cos(.78)); g.add(cap);
          g.add(box(w - .06, .004, .003, '#b9c3ca', 0, .08, fz + .002));
          break;
        }
        case 'crib': {
          const wm = woodM(c);
          g.add(rbox(w - .09, .12, d - .09, fabric('#ffffff'), 0, .3, 0, .04), box(w - .06, .025, d - .06, wm, 0, .28));
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => g.add(rbox(.045, .95, .045, wm, a * (w / 2 - .022), 0, b * (d / 2 - .022), .008), blob(.028, .028, .028, wm, a * (w / 2 - .022), .97, b * (d / 2 - .022), 14)));
          [-1, 1].forEach(s => {
            const z = s * (d / 2 - .022), x = s * (w / 2 - .022);
            g.add(rbox(w - .05, .035, .03, wm, 0, .88, z, .008), rbox(w - .05, .035, .03, wm, 0, .25, z, .008), rbox(.03, .035, d - .05, wm, x, .88, 0, .008), rbox(.03, .035, d - .05, wm, x, .25, 0, .008));
            for (let p = -w / 2 + .09; p < w / 2 - .05; p += .075) g.add(rod([p, .28, z], [p, .88, z], .009, wm, .009, 8));
            for (let p = -d / 2 + .09; p < d / 2 - .05; p += .075) g.add(rod([x, .28, p], [x, .88, p], .009, wm, .009, 8));
          });
          g.add(rbox(w * .5, .03, d - .14, fabric('#f3d9c9'), w * .12, .42, 0, .015), rbox(.3, .06, .2, fabric('#fbfaf7'), -w / 2 + .22, .42, 0, .03));
          const bx = -w * .3 + .1, bear = '#c9a27a';
          g.add(blob(.05, .06, .045, bear, bx, .5, .12), blob(.045, .042, .04, bear, bx, .59, .12), blob(.016, .016, .01, bear, bx - .032, .625, .12), blob(.016, .016, .01, bear, bx + .032, .625, .12));
          break;
        }
        case 'beanbag': {
          const fab = mat(c, { roughness: .95 });
          g.add(blob(w * .5, .3, d * .5, fab, 0, .3, 0, 40), blob(w * .42, .22, d * .22, fab, 0, .5, bz + d * .26, 32));
          break;
        }
        case 'sidetable': {
          const r = Math.min(w, d) / 2, bm = blackMetal();
          g.add(lathe([[r * .55, 0], [r * .55, .012], [.03, .035], [.018, .3], [.025, .5], [.08, .52]], bm, 0, 0, 0, 40), cyl(r, r * .98, .025, mat(c, { roughness: .35 }), 0, .52, 0, 48));
          g.add(box(.16, .02, .12, '#4f6b8a', -r * .25, .545, 0));
          vase(g, r * .35, .545, -r * .1, .035, .12, '#e9e2d6', R, false);
          break;
        }
        case 'floorlamp': {
          const r = Math.min(w, d) / 2, lm = mat(c, { roughness: .35, metalness: .5 });
          g.add(lathe([[0, 0], [r * .55, 0], [r * .58, .012], [r * .5, .03], [.02, .035]], lm, 0, 0, 0, 40), rod([0, .03, 0], [0, 1.36, 0], .011, lm));
          g.add(lathe([[r * .85, 0], [r * .55, .36]], glowMat('#f6ecd9', '#ffdca0', .45), 0, 1.22, 0, 48), blob(.035, .035, .035, glowMat('#fff', '#ffe2b0', 1.2), 0, 1.36, 0, 12));
          g.add(ring(r * .85, .004, lm, 0, 1.22, 0), ring(r * .55, .004, lm, 0, 1.58, 0));
          break;
        }
        case 'island': {
          const cm = mat(c, { roughness: .45 }), stone = mat('#dcd7cf', { roughness: .2 }), cd = d - .3, n = Math.max(1, Math.round((w - .1) / .6)), cab = new THREE.Group(), fz = cd / 2 - .03;
          cab.add(box(w - .12, .1, cd - .08, '#4a4641', 0, 0, -.04), box(w - .1, .74, cd - .03, cm, 0, .1, -.015));
          fronts(cab, -w / 2 + .05, .64, w - .1, .2, fz, n, 1, cm, 'bar'); fronts(cab, -w / 2 + .05, .1, w - .1, .54, fz, n, 1, cm, 'bar', .56);
          cab.rotation.y = Math.PI; cab.position.z = bz + cd / 2; g.add(cab);                    // 柜门朝 -z，+z 侧留出吧台挑空
          g.add(rbox(w, .05, d, stone, 0, .84, 0, .006));
          [-1, 1].forEach(s => g.add(box(.04, .84, d, stone, s * (w / 2 - .02), 0, 0)));             // 瀑布式侧板
          g.add(lathe([[0, 0], [.06, 0], [.14, .06], [.15, .07]], mat('#6b543f', { roughness: .5, side: THREE.DoubleSide }), w * .22, .89, 0, 32));
          for (let k = 0; k < 4; k++) g.add(blob(.04, .04, .04, ['#d98c4a', '#9fbf5a', '#b5463a', '#e6c14f'][k], w * .22 + Math.cos(k * 1.6) * .05, .935 + (k === 3 ? .04 : 0), Math.sin(k * 1.6) * .05, 14));
          vase(g, -w * .25, .89, -.05, .05, .22, '#e9e2d6', R);
          break;
        }
        case 'barstool': {
          const r = Math.min(w, d) / 2, bm = blackMetal(), sy = .7;
          [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => g.add(rod([a * r * .72, 0, b * r * .72], [a * r * .4, sy, b * r * .4], .011, bm)));
          g.add(ring(Math.SQRT2 * r * (.72 - .32 * .4), .008, bm, 0, .28, 0), cyl(r * .55, r * .55, .02, bm, 0, sy - .01, 0, 32));
          g.add(lathe([[0, 0], [r * .85, 0], [r * .95, .02], [r * .97, .045], [r * .9, .07], [0, .075]], mat(c, { roughness: .6 }), 0, sy, 0, 40));
          break;
        }
        case 'waterheater': {
          const r = Math.min(d / 2, .23), L = w - .06, yc = 1.95, zc = bz + r + .02, tm = mat(c, { roughness: .35 }), cp = mat('#cfd4d8', { roughness: .4 });
          const tank = mesh(new THREE.CylinderGeometry(r, r, L, 40), tm); tank.rotation.z = Math.PI / 2; tank.position.set(0, yc, zc); g.add(tank);
          [-1, 1].forEach(s => g.add(blob(.035, r * .99, r * .99, cp, s * L / 2, yc, zc, 32), box(.05, r * 1.1, .02, '#9a9ea3', s * L * .3, yc - r * .55, bz + .01)));
          g.add(rbox(.2, .09, .02, '#e7eaec', L * .18, yc - .05, zc + r * .93, .008), box(.07, .03, .002, screenMat('#2f8f7a'), L * .18 - .04, yc - .02, zc + r * .93 + .011));
          [[-L * .3, '#3b7bbf'], [-L * .18, '#c0463a']].forEach(([x, cc]) => g.add(rod([x, yc - r * .8, zc], [x, 1.3, zc], .012, metal()), cyl(.02, .02, .03, cc, x, 1.5, zc, 12)));
          break;
        }
        case 'tv': {
          const th = w * .5625, yb = 1.2 - th / 2, z = bz + .03;
          g.add(rbox(w * .6, th * .6, .03, '#222', 0, yb + th * .2, bz + .015, .01));
          g.add(rbox(w, th, .025, mat('#18181a', { roughness: .4, metalness: .3 }), 0, yb, z + .01, .004), box(w - .016, th - .022, .002, screenMat('#1f2b3a'), 0, yb + .014, z + .0235), box(.04, .006, .002, '#8a8a8e', 0, yb + .004, z + .0235));
          break;
        }
        case 'aircon': {
          const am = mat(c, { roughness: .3 }), h = 1.8, fz = d / 2 - .005;
          g.add(rbox(w, .06, d, '#cfd3d6', 0, 0, 0, .015), rbox(w - .01, h - .06, d - .01, am, 0, .06, 0, .06));
          g.add(rbox(w - .06, 1.0, .01, mat(lighter(c, .4), { roughness: .12 }), 0, .22, fz, .005), box(w - .1, .42, .01, '#3d4145', 0, 1.28, fz));
          for (let i = 0; i < 8; i++) g.add(rot(box(w - .11, .012, .03, '#e4e7ea', 0, 1.3 + i * .05, fz + .008), -.35));
          g.add(box(.1, .035, .003, mat('#101214', { emissive: '#4fb3a5', emissiveIntensity: .7 }), 0, 1.12, fz + .006));
          for (let i = 0; i < 8; i++) g.add(box(w - .12, .005, .004, '#b9bfc4', 0, .09 + i * .015, fz + .002));
          break;
        }
        case 'acwall': {
          const h = .3, am = mat(c, { roughness: .3 }), s = new THREE.Shape();
          s.moveTo(0, .02); s.lineTo(0, h); s.lineTo(d * .75, h); s.quadraticCurveTo(d, h, d, h * .55); s.quadraticCurveTo(d, 0, d * .55, 0); s.lineTo(.02, 0); s.lineTo(0, .02);
          const geo = new THREE.ExtrudeGeometry(s, { depth: w - .02, bevelEnabled: true, bevelThickness: .01, bevelSize: .006, bevelSegments: 3, curveSegments: 16 });
          geo.rotateY(-Math.PI / 2); geo.translate((w - .02) / 2, 2.2, bz); g.add(mesh(geo, am));
          g.add(box(w - .12, .004, .07, '#3a3d40', 0, 2.19, bz + d * .55), rot(box(w - .12, .008, .06, am, 0, 2.18, bz + d * .72), .35));
          g.add(box(.06, .018, .002, mat('#101214', { emissive: '#4fb3a5', emissiveIntensity: .7 }), w * .3, 2.2 + h * .5, bz + d + .007));
          for (let i = 0; i < 6; i++) g.add(box(w - .12, .003, .008, '#d5d9dc', 0, 2.2 + h + .006, bz + .03 + i * .022));
          break;
        }
        case 'dishwasher': {
          const dm = mat(c, { metalness: .55, roughness: .28 }), fz = d / 2 - .02;
          g.add(box(w - .01, .08, d - .07, '#3a3834', 0, 0, -.035), box(w - .005, .76, d - .03, '#8b9095', 0, .08, -.015));
          g.add(rbox(w - .006, .7, .02, dm, 0, .085, fz, .004), box(w - .006, .055, .02, '#26282a', 0, .785, fz));
          for (let i = 0; i < 4; i++) g.add(box(.012, .006, .002, mat('#101214', { emissive: i ? '#6fd0ff' : '#7fe08a', emissiveIntensity: .8 }), w * .1 + i * .03, .81, fz + .011));
          pull(g, w * .6, false, 0, .74, fz + .01);
          break;
        }
        case 'ovencol': {
          const cm = mat(c, { roughness: .5 }), h = 2.1, fz = d / 2 - .02, frm = mat('#1c1d1f', { roughness: .3, metalness: .5 }), gl = mat('#0b0c0d', { roughness: .03, metalness: .6 });
          g.add(box(w - .02, .08, d - .06, '#4a4641', 0, 0, -.03), box(w, h - .08, d - .02, cm, 0, .08, -.01));
          fronts(g, -w / 2, .08, w, .6, fz, 1, 2, cm, 'bar'); fronts(g, -w / 2, 1.78, w, h - 1.8, fz, 1, 1, cm, 'bar', 1.84);
          [[.7, .58], [1.3, .46]].forEach(([y, ah]) => {
            g.add(box(w - .02, ah - .01, .02, frm, 0, y, fz + .01), box(w - .1, ah * .52, .003, gl, 0, y + ah * .1, fz + .021), box(w - .04, .06, .003, '#2a2c2e', 0, y + ah - .075, fz + .021));
            g.add(box(.08, .022, .002, mat('#101214', { emissive: '#ff9a3c', emissiveIntensity: .7 }), 0, y + ah - .056, fz + .023));
            pull(g, w * .7, false, 0, y + ah * .72, fz + .02);
          });
          break;
        }
        case 'purifier': {
          const pm = mat(c, { roughness: .45 }), h = .72;
          g.add(rbox(w, h, d, pm, 0, 0, 0, Math.min(w, d) * .2), rbox(w - .05, .006, d - .05, '#8d959b', 0, h - .002, 0, .02));
          for (let i = 0; i < 7; i++) g.add(box(w - .07, .004, .006, '#6f777d', 0, h + .002, -d / 2 + .05 + i * (d - .1) / 6));
          g.add(rbox(w - .06, .42, .006, fabric('#c8ccd0'), 0, .06, d / 2 - .001, .01));
          const rg = new THREE.Mesh(new THREE.TorusGeometry(.03, .004, 8, 32), mat('#101214', { emissive: '#4fb3a5', emissiveIntensity: .8 })); rg.position.set(0, .6, d / 2 + .002); g.add(rg);
          break;
        }
        case 'officechair': {
          const r = Math.min(w, d) * .46, dk = darker(c, .75), bm = mat('#2b2b2d', { roughness: .45 }), cm = chrome();
          for (let k = 0; k < 5; k++) {
            const a = k * Math.PI * 2 / 5, tx = Math.sin(a) * r * .95, tz = Math.cos(a) * r * .95;
            g.add(rod([0, .1, 0], [tx, .07, tz], .022, bm, .014, 10), cyl(.008, .008, .03, bm, tx, .04, tz, 8), rot(cyl(.026, .026, .03, '#111', tx, .026 - .015, tz, 16), 0, a, Math.PI / 2));
          }
          g.add(cyl(.05, .06, .05, bm, 0, .08, 0, 20), cyl(.025, .025, .22, cm, 0, .12, 0, 16), cyl(.036, .036, .12, bm, 0, .12, 0, 16), rbox(.22, .05, .22, bm, 0, .34, .02, .01));
          g.add(rbox(w * .78, .03, d * .72, bm, 0, .38, .04, .01), rbox(w * .8, .08, d * .74, fabric(c), 0, .4, .05, .035));
          g.add(tube([[0, .36, 0], [0, .38, bz + .12], [0, .6, bz + .07]], .02, bm));
          const bf = shell(w * .72, .6, .03, .025, .08, bm); bf.rotation.x = Math.PI / 2 - .12; bf.position.set(0, .88, bz + .06); g.add(bf);
          g.add(rot(box(w * .68, .56, .006, mat(dk, { roughness: .85, transparent: true, opacity: .88, side: THREE.DoubleSide }), 0, .6, bz + .085), -.12), rot(rbox(w * .5, .08, .03, fabric(c), 0, .66, bz + .11, .015), -.12));
          g.add(rod([-.05, 1.14, bz + .025], [-.05, 1.22, bz + .015], .008, bm), rod([.05, 1.14, bz + .025], [.05, 1.22, bz + .015], .008, bm), rbox(w * .45, .12, .05, fabric(dk), 0, 1.2, bz + .02, .025));
          [-1, 1].forEach(s => g.add(box(.035, .22, .035, bm, s * w * .4, .42, .04), rbox(.07, .03, d * .4, bm, s * w * .4, .63, .04, .012)));
          break;
        }
        case 'piano': {
          const pk = mat(c, { roughness: .12, metalness: .1 }), bd = d * .5, kz = bz + bd, h = 1.25, kd = d * .22 - .03, iv = mat('#faf8f3', { roughness: .3 }), eb = mat('#111', { roughness: .25 }), kw = (w - .12) / 52;
          g.add(box(w, h, bd, pk, 0, 0, bz + bd / 2), rbox(w + .02, .03, bd + .03, pk, 0, h, bz + bd / 2 + .01, .008));
          [-1, 1].forEach(s => g.add(rbox(.06, .13, kd + .06, pk, s * (w / 2 - .03), .6, kz + (kd + .06) / 2, .01), box(.05, .6, .05, pk, s * (w / 2 - .08), 0, kz + kd + .01), box(.06, .04, d - bd, pk, s * (w / 2 - .08), 0, kz + (d - bd) / 2)));
          g.add(box(w - .12, .08, kd + .05, pk, 0, .6, kz + (kd + .05) / 2), box(w - .12, .1, .03, pk, 0, .68, kz + .015));
          for (let i = 0; i < 52; i++) {
            const x = -w / 2 + .06 + kw * (i + .5); g.add(box(kw - .0015, .022, kd, iv, x, .68, kz + .03 + kd / 2));
            if (i < 51 && 'ACDFG'.includes('ABCDEFG'[i % 7])) g.add(box(kw * .58, .02, kd * .62, eb, x + kw / 2, .7, kz + .03 + kd * .31));
          }
          g.add(rot(box(w * .42, .18, .012, pk, 0, .84, kz + .012), -.25));
          [-.06, 0, .06].forEach(x => g.add(box(.025, .012, .07, mat('#c9a35a', { metalness: .9, roughness: .3 }), x, .05, kz + .03)));
          const mt = cyl(.0, .05, .2, woodM('#5a3e2b'), w * .3, h + .03, bz + bd / 2, 4); mt.rotation.y = Math.PI / 4; g.add(mt);
          g.add(rot(box(.14, .18, .015, woodM('#c9a27a'), -w * .3, h + .03, bz + .06), -.15), rot(box(.11, .14, .002, '#9fb3c2', -w * .3, h + .05, bz + .07), -.15));
          break;
        }
        case 'treadmill': {
          const tm = mat(c, { roughness: .55 }), bm = mat('#2a2a2c', { roughness: .5 }), al = mat('#9a9ea3', { metalness: .6, roughness: .4 });
          g.add(rbox(w, .14, d - .25, tm, 0, .03, .125, .03), box(w - .16, .006, d - .5, '#141414', 0, .17, .15));
          [-1, 1].forEach(s => g.add(box(.07, .008, d - .45, al, s * (w / 2 - .05), .17, .15)));
          [bz + .06, d / 2 - .06].forEach(z => [-1, 1].forEach(s => g.add(box(.06, .03, .06, bm, s * (w / 2 - .06), 0, z))));
          g.add(rbox(w, .22, .32, tm, 0, 0, bz + .16, .05));
          [-1, 1].forEach(s => g.add(rod([s * (w / 2 - .06), .15, bz + .2], [s * (w / 2 - .06), 1.15, bz + .3], .025, bm, .022), tube([[s * (w / 2 - .06), 1.0, bz + .28], [s * (w / 2 - .06), 1.0, bz + .5], [s * (w / 2 - .07), .97, bz + .62]], .018, bm)));
          const cg = new THREE.Group(); cg.position.set(0, 1.2, bz + .31); cg.rotation.x = -.5;
          cg.add(rbox(w * .8, .2, .08, bm, 0, -.1, 0, .02), box(w * .4, .11, .004, screenMat('#2a5d8f'), 0, -.055, .041)); g.add(cg);
          break;
        }
        default: g.add(box(w, .8, d, c));
      }
      g.position.set(wx(f.cx), 0, wz(f.cy));
      g.rotation.y = -f.rot * Math.PI / 180;       // 平面顺时针旋转 → 绕 Y 轴负向
      g.userData.fid = f.id;
      return g;
    }

    function buildGlassWall(P0, P1, Tmm, h) {                // 玻璃隔断：整片玻璃 + 两端边框 + 上下框条
      const L = M(Math.hypot(P1[0] - P0[0], P1[1] - P0[1])), TT = M(Tmm);
      if (L < .05 || h < .1) return;
      const rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(L, h, .012), glassMat);
      pane.position.set(mx, h / 2, mz); pane.rotation.y = rot; archUp.add(pane);
      const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
      [-L / 2 + .03, L / 2 - .03].forEach(off => {           // 两端立梃
        const post = new THREE.Mesh(new THREE.BoxGeometry(.06, h, Math.max(.06, TT)), frameMat);
        post.position.set(mx + dx * off, h / 2, mz + dz * off); post.castShadow = true; archUp.add(post);
      });
      [.03, h - .03].forEach(y => {                          // 上 / 下横框
        const bar = new THREE.Mesh(new THREE.BoxGeometry(L, .06, Math.max(.06, TT)), frameMat);
        bar.position.set(mx, y, mz); bar.rotation.y = rot; bar.castShadow = true; archUp.add(bar);
      });
    }

    /* ======================= 建筑 ======================= */
    function clearGroup(g) {
      g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.userData && o.material.userData._disposable) o.material.dispose();   // 克隆的一次性材质一并释放（mat() 缓存的共享材质不动）
      });
      g.clear();
    }
    const oneMat = m => { m.userData._disposable = true; return m; };   // 标记一次性材质（clone 出来的），方案重建时随 clearGroup 释放
    let streetPoolTex = null;                                    // 路灯地面光斑共用的径向渐变贴图（只创建一次，材质随方案释放）
    function streetPoolTexture() {                               // Canvas 生成暖黄径向渐变：中心亮、边缘透明
      if (streetPoolTex) return streetPoolTex;
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const ctx = c.getContext('2d'), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,232,178,.95)'); g.addColorStop(.35, 'rgba(255,211,130,.45)'); g.addColorStop(1, 'rgba(255,196,96,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
      streetPoolTex = new THREE.CanvasTexture(c); streetPoolTex.colorSpace = THREE.SRGBColorSpace;
      return streetPoolTex;
    }
    const signFaceCache = new Map();
    /* ===== 新增 GB 5768 标志牌面绘制（256×256 圆/三角/倒三角，横矩形 512×200，竖矩形 256×512）=====
       统一先铺板形底色与边框，再按 art 画简笔图案；仅依赖 def，新增标志只需在 SIGN_DEFS 加一行 + 一个 art 分支。 */
    function drawNewSignFace(g, e, def) {
      const S = 256, BLUE = '#1a6db5', RED = '#cf3126', YEL = '#f7c948', GRY = '#8a8f94', INK = '#161616';
      const wide = def.shape === 'rect', portrait = !!def.portrait;
      const W = portrait ? 256 : (wide ? 512 : S), H = portrait ? 512 : (wide ? 200 : S);
      g.clearRect(0, 0, W, H);
      // 板形底色 / 边框
      if (def.shape === 'tri') {
        // 三角贴图画满整幅画布：3D 板形 uv 归一化到 0..1，若这里留白会让牌面边缘一圈漏空（约 30%）
        g.fillStyle = YEL; g.strokeStyle = INK; g.lineWidth = 20; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fill(); g.stroke();
      } else if (def.shape === 'invtri') {
        g.fillStyle = '#fff'; g.strokeStyle = RED; g.lineWidth = 22; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W / 2, H); g.closePath(); g.fill(); g.stroke();
      } else if (def.shape === 'rect') {
        g.fillStyle = def.style === 'guide' ? '#1565a8' : BLUE; g.fillRect(0, 0, W, H);
        g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(12, 12, W - 24, H - 24);
      } else if (def.style === 'ban') {                       // 禁令圆牌：白底红环（停车类蓝底白环）；解除限速为白底粗黑圈
        const _endSpd = def.art === 'endLimit';
        g.fillStyle = '#fff'; g.beginPath(); g.arc(W / 2, H / 2, W / 2 - 6, 0, Math.PI * 2); g.fill();
        g.strokeStyle = _endSpd ? INK : RED;
        g.lineWidth = _endSpd ? 22 : 26;                       // 解除限速按国标为醒目粗黑圈
        g.beginPath(); g.arc(W / 2, H / 2, _endSpd ? W / 2 - 17 : W / 2 - 20, 0, Math.PI * 2); g.stroke();
      } else if (def.style === 'ind') {                       // 指示圆牌：蓝底
        g.fillStyle = BLUE; g.beginPath(); g.arc(W / 2, H / 2, W / 2 - 6, 0, Math.PI * 2); g.fill();
      }
      const cx = W / 2, cy = H / 2, uni = def.style === 'warn' ? INK : '#fff';
      g.lineJoin = 'round'; g.lineCap = 'round';
      const text = (t, x, y, size, col) => { g.fillStyle = col || uni; g.font = `bold ${size}px "Microsoft YaHei", Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, x, y); };
      const arrow = (x1, y1, x2, y2, col, lw) => {            // 带实心箭头的线
        col = col || uni; lw = lw || 20; const a = Math.atan2(y2 - y1, x2 - x1), hs = lw * 1.5;
        g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        g.fillStyle = col; g.beginPath(); g.moveTo(x2, y2);
        g.lineTo(x2 - hs * Math.cos(a - .5), y2 - hs * Math.sin(a - .5));
        g.lineTo(x2 - hs * Math.cos(a + .5), y2 - hs * Math.sin(a + .5)); g.closePath(); g.fill();
      };
      const carBody = (x, y, sc, col) => { g.fillStyle = col; g.fillRect(x - 34 * sc, y - 12 * sc, 68 * sc, 26 * sc); g.beginPath(); g.arc(x - 20 * sc, y + 15 * sc, 9 * sc, 0, 7); g.arc(x + 20 * sc, y + 15 * sc, 9 * sc, 0, 7); g.fill(); };
      const slash = (col, one) => { g.strokeStyle = col; g.lineWidth = 24; if (one) { g.beginPath(); g.moveTo(58, W - 58); g.lineTo(W - 58, 58); g.stroke(); } else { g.beginPath(); g.moveTo(58, 58); g.lineTo(W - 58, W - 58); g.moveTo(W - 58, 58); g.lineTo(58, W - 58); g.stroke(); } };
      // 警告三角：图案裁剪在牌面内，避免坡角/箭头翼/人物等笔划戳出三角边界（在 3D 里会飘到牌外）
      if (def.shape === 'tri') {
        g.save();
        g.beginPath(); g.moveTo(cx, 12); g.lineTo(W - 14, H - 16); g.lineTo(14, H - 16); g.closePath(); g.clip();
      }
      switch (def.art) {
        // ---- 警告 ----
        case 'cross': g.fillStyle = INK; g.fillRect(cx - 20, 92, 40, 100); g.fillRect(cx - 60, 130, 120, 30); break;
        case 'tcross': g.fillStyle = INK; g.fillRect(cx - 20, 96, 40, 72); g.fillRect(cx - 62, 92, 124, 30); break;
        case 'curveL': arrow(160, 200, 160, 130, INK); arrow(160, 130, 88, 110, INK); break;
        case 'curveR': arrow(96, 200, 96, 130, INK); arrow(96, 130, 168, 110, INK); break;
        case 'revCurve': arrow(150, 200, 150, 140, INK); arrow(150, 140, 104, 140, INK); arrow(104, 140, 104, 82, INK); break;
        case 'contCurve': arrow(170, 198, 170, 150, INK); arrow(170, 150, 110, 150, INK); arrow(110, 150, 110, 92, INK); text('≫', cx - 4, 66, 40, INK); break;
        case 'steepUp': g.fillStyle = INK; g.beginPath(); g.moveTo(54, 198); g.lineTo(202, 92); g.lineTo(202, 198); g.closePath(); g.fill(); arrow(90, 176, 168, 122, '#fff', 16); break;
        case 'steepDown': g.fillStyle = INK; g.beginPath(); g.moveTo(54, 92); g.lineTo(202, 198); g.lineTo(54, 198); g.closePath(); g.fill(); arrow(88, 118, 166, 172, '#fff', 16); break;
        case 'narrow': g.strokeStyle = INK; g.lineWidth = 16; g.beginPath(); g.moveTo(58, 200); g.lineTo(108, 84); g.moveTo(198, 200); g.lineTo(148, 84); g.stroke(); break;
        case 'narrowBridge': g.strokeStyle = INK; g.lineWidth = 14; g.strokeRect(78, 96, 100, 96); g.beginPath(); g.moveTo(78, 120); g.lineTo(178, 120); g.moveTo(78, 168); g.lineTo(178, 168); g.stroke(); break;
        case 'twoWay': arrow(96, 190, 96, 92, INK, 16); arrow(160, 92, 160, 190, INK, 16); break;
        case 'children': g.fillStyle = INK; g.beginPath(); g.arc(100, 96, 20, 0, 7); g.arc(160, 108, 16, 0, 7); g.fill(); g.fillRect(86, 118, 28, 62); g.fillRect(148, 126, 24, 52); break;
        case 'signal': g.fillStyle = INK; g.fillRect(cx - 26, 76, 52, 106); g.fillStyle = YEL; [98, 128, 158].forEach(y => { g.beginPath(); g.arc(cx, y, 12, 0, 7); g.fill(); }); break;
        case 'rock': g.fillStyle = INK; [[96, 92, 22], [154, 106, 18], [124, 148, 26]].forEach(([x, y, r]) => { g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y + r); g.lineTo(x - r, y + r); g.closePath(); g.fill(); }); break;
        case 'tunnel': g.strokeStyle = INK; g.lineWidth = 16; g.beginPath(); g.arc(cx, 190, 74, Math.PI, 0); g.stroke(); g.beginPath(); g.moveTo(cx - 74, 190); g.lineTo(cx - 74, 214); g.moveTo(cx + 74, 190); g.lineTo(cx + 74, 214); g.stroke(); break;
        case 'construction': g.fillStyle = YEL; g.fillRect(96, 132, 64, 56); g.fillStyle = INK; for (let i = 0; i < 3; i++) g.fillRect(100 + i * 20, 188, 14, 12); text('施', cx, 102, 54, INK); break;
        case 'village': g.fillStyle = INK; g.fillRect(68, 128, 52, 60); g.fillRect(140, 112, 50, 76); g.fillStyle = YEL; g.fillRect(88, 154, 14, 34); g.fillRect(158, 144, 14, 44); break;
        case 'slow': text('慢', cx, 170, 92, INK); break;
        // ---- 禁令 ----
        case 'noPass': break;                                  // 红圈空心即图案本身
        case 'noHorn': {                                       // 禁止鸣喇叭（GB 5768）：小号侧影＝左大喇叭口 + 中部 U 形回环弯管 + 右吹嘴 + 左上→右下红斜杠
          // 中部 U 形回环弯管：黑色管壁、白色内腔（先画，后由上方管身压住上端形成连接）
          g.strokeStyle = INK; g.lineWidth = 14; g.lineCap = 'round'; g.lineJoin = 'round';
          g.beginPath();
          g.moveTo(100, 126); g.lineTo(100, 148);
          g.quadraticCurveTo(100, 160, 114, 160);
          g.lineTo(126, 160);
          g.quadraticCurveTo(138, 160, 138, 148); g.lineTo(138, 126);
          g.stroke();
          // 上方水平管身（右端圆角）
          g.fillStyle = INK; g.fillRect(104, 110, 76, 28);
          g.beginPath(); g.arc(180, 124, 14, -Math.PI / 2, Math.PI / 2); g.fill();
          // 左侧大喇叭口：左沿竖直、上/下沿曲线收窄接管身（漏斗形）
          g.beginPath();
          g.moveTo(44, 76);
          g.bezierCurveTo(72, 90, 92, 104, 108, 116);
          g.lineTo(108, 140);
          g.bezierCurveTo(92, 150, 72, 154, 44, 160);
          g.closePath(); g.fill();
          // 喇叭口内壁白色月牙（上沿内侧）
          g.fillStyle = '#fff';
          g.beginPath();
          g.moveTo(48, 82);
          g.bezierCurveTo(72, 96, 92, 108, 106, 120);
          g.bezierCurveTo(90, 113, 70, 102, 48, 93);
          g.closePath(); g.fill();
          g.fillStyle = INK;
          // 右侧小吹嘴：细杆 + 外张的小喇叭口
          g.fillRect(190, 114, 12, 20);
          g.beginPath(); g.moveTo(202, 110); g.lineTo(216, 104); g.lineTo(216, 144); g.lineTo(202, 138); g.closePath(); g.fill();
          // 禁令斜杠（左上 → 右下，较粗）
          g.strokeStyle = RED; g.lineWidth = 32; g.lineCap = 'butt';
          g.beginPath(); g.moveTo(58, 58); g.lineTo(W - 58, H - 58); g.stroke();
          break;
        }
        case 'noParking': case 'noLongPark': g.fillStyle = BLUE; g.beginPath(); g.arc(cx, cy, W / 2 - 20, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 24; g.beginPath(); g.arc(cx, cy, W / 2 - 20, 0, 7); g.stroke(); if (def.art === 'noParking') slash(RED, false); else slash(RED, true); break;
        case 'heightLimit': g.fillStyle = '#141414'; g.font = 'bold 40px Arial'; g.textAlign = 'center'; g.fillText('限高', cx, 100); text(String(e.limit ?? def.def), cx, 156, 74, '#141414'); break;
        case 'weightLimit': g.fillStyle = '#141414'; g.font = 'bold 40px Arial'; g.textAlign = 'center'; g.fillText('限重', cx, 100); text(String(e.limit ?? def.def) + 't', cx, 158, 66, '#141414'); break;
        case 'noOvertake': carBody(104, 120, .8, INK); carBody(150, 176, .8, RED); slash(RED, true); break;
        case 'meetYield': {                                    // 会车让行：白底红圈，左黑箭头向下、右红箭头向上（按用户样图方向）
          g.save(); g.beginPath(); g.arc(cx, cy, W / 2 - 30, 0, 7); g.clip();
          // 左：黑色向下——粗杆 + 大三角头
          g.fillStyle = INK; g.fillRect(80, 76, 22, 62);
          g.beginPath(); g.moveTo(91, 196); g.lineTo(58, 132); g.lineTo(124, 132); g.closePath(); g.fill();
          // 右：红色向上——细杆 + 小三角头（让行方箭头较细）
          g.fillStyle = RED; g.fillRect(159, 118, 12, 62);
          g.beginPath(); g.moveTo(165, 60); g.lineTo(145, 124); g.lineTo(185, 124); g.closePath(); g.fill();
          g.restore();
          break;
        }
        case 'endLimit': {                                     // 解除限制速度（GB 5768）：白底粗黑圈 + 黑字 + 左下→右上的密集黑细斜杠（压在字下）
          g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, W / 2 - 6, 0, 7); g.fill();
          // 7 条平行细斜杠组成的中间带：方向左下→右上（斜率 -1），裁剪在圈内压在数字下
          g.save();
          g.beginPath(); g.arc(cx, cy, W / 2 - 22, 0, 7); g.clip();
          g.strokeStyle = INK; g.lineWidth = 4; g.lineCap = 'butt';
          for (let i = -3; i <= 3; i++) {
            const c = cx + cy + i * 12;                         // 直线 x+y=c，环绕中心的中带
            g.beginPath(); g.moveTo(c - H, H); g.lineTo(H, c - H); g.stroke();
          }
          g.restore();
          text(String(e.limit ?? def.def ?? 60), cx, cy, 124, INK);
          break;
        }
        case 'yield': text('让', cx, 100, 92, INK); break;
        // ---- 指示 ----
        case 'roundabout': {                                   // 环岛行驶：三个白色箭头首尾相接、逆时针绕环（GB 5768）
          const R = 62, lw = 16, span = 72 * Math.PI / 180;    // 三段各跨 72°、间隔 120°，留 48° 均匀间隙不连成闭环
          g.strokeStyle = '#fff'; g.lineWidth = lw;
          for (let i = 0; i < 3; i++) {
            const a0 = -Math.PI / 2 + i * 2 * Math.PI / 3, a1 = a0 - span;
            g.beginPath(); g.arc(cx, cy, R, a1, a0); g.stroke();
            const ux = Math.sin(a1), uy = -Math.cos(a1);        // 逆时针切线（箭尖伸出方向）
            const nx = Math.cos(a1), ny = Math.sin(a1);        // 径向（三角底边展开方向）
            const bx = cx + R * nx - 2 * ux, by = cy + R * ny - 2 * uy;  // 底边中点：接在弧末端
            g.fillStyle = '#fff'; g.beginPath();
            g.moveTo(bx + 26 * ux, by + 26 * uy);              // 箭尖沿切线前伸
            g.lineTo(bx + 22 * nx, by + 22 * ny);
            g.lineTo(bx - 22 * nx, by - 22 * ny);
            g.closePath(); g.fill();
          }
          break;
        }
        case 'allowUTurn': g.strokeStyle = '#fff'; g.lineWidth = 22; g.beginPath(); g.moveTo(cx - 52, 196); g.lineTo(cx - 52, 120); g.arc(cx, 120, 52, Math.PI, 0); g.lineTo(cx + 52, 172); g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx + 52, 224); g.lineTo(cx + 22, 168); g.lineTo(cx + 82, 168); g.closePath(); g.fill(); break;
        case 'crosswalk': g.fillStyle = '#fff'; for (let i = 0; i < 4; i++) g.fillRect(72 + i * 30, 150, 18, 62); g.beginPath(); g.arc(cx, 84, 16, 0, 7); g.fill(); g.fillRect(cx - 8, 100, 16, 44); break;
        case 'motorLane': carBody(cx, 148, 1.5, '#fff'); break;
        case 'nonMotorLane': case 'nonMotor': g.strokeStyle = '#fff'; g.lineWidth = 11; g.beginPath(); g.arc(cx - 40, 172, 34, 0, 7); g.arc(cx + 42, 172, 34, 0, 7); g.stroke(); g.beginPath(); g.moveTo(cx - 40, 172); g.lineTo(cx - 6, 118); g.lineTo(cx + 22, 118); g.lineTo(cx + 42, 172); g.moveTo(cx - 6, 118); g.lineTo(cx + 42, 172); g.stroke(); g.beginPath(); g.arc(cx + 24, 92, 13, 0, 7); g.stroke(); break;
        case 'minSpeed': text(String(e.limit ?? def.def), cx, cy + 10, 104, '#fff'); break;
        case 'oneWay': g.strokeStyle = '#fff'; g.lineWidth = 26; g.beginPath(); g.moveTo(cx, 396); g.lineTo(cx, 200); g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx, 116); g.lineTo(cx - 56, 208); g.lineTo(cx + 56, 208); g.closePath(); g.fill(); break;
        // ---- 指路 / 服务 ----
        case 'advance': text(String(e.text || def.def), 256, 74, 58, '#fff'); arrow(150, 146, 256, 146, '#fff', 16); text('路口', 356, 146, 44, '#fff'); break;
        case 'distance': { const parts = String(e.text || def.def).split(/\s+/); text(parts[0] || '前方路口', 256, 62, 50, '#fff'); text(parts.slice(1).join(' ') || '200m', 256, 136, 56, '#fff'); break; }
        case 'fuel': text('⛽', cx, 78, 68, '#fff'); text('加油站', cx, 148, 40, '#fff'); break;
        case 'charge': text('⚡', cx, 78, 72, '#fff'); text('充电桩', cx, 148, 40, '#fff'); break;
        case 'parking': text('P', cx, 84, 92, '#fff'); text(e.text || '停车场', cx, 150, 38, '#fff'); break;
        case 'toilet': text('WC', cx, 78, 66, '#fff'); text('厕所', cx, 148, 40, '#fff'); break;
        default: break;
      }
      if (def.shape === 'tri') g.restore();
    }
    function signFaceTexture(e) {                                // 交通标志牌面 Canvas 贴图：按类型 / 箭头样式 / 限速值 / 文字绘制
      const key = [e.type, e.style || '', e.limit ?? '', e.text || ''].join('|');
      if (signFaceCache.has(key)) return signFaceCache.get(key);
      const _def = signDef(e.type);                             // 新增 GB 5768 标志：配置驱动绘制
      if (_def) {
        const cc = document.createElement('canvas');
        cc.width = _def.portrait ? 256 : (_def.shape === 'rect' ? 512 : 256);
        cc.height = _def.portrait ? 512 : (_def.shape === 'rect' ? 200 : 256);
        drawNewSignFace(cc.getContext('2d'), e, _def);
        const tt = new THREE.CanvasTexture(cc); tt.colorSpace = THREE.SRGBColorSpace; tt.anisotropy = 4;
        signFaceCache.set(key, tt); return tt;
      }
      const wide = e.type === 'signboard';
      const c = document.createElement('canvas'); c.width = wide ? 512 : 256; c.height = wide ? 164 : 256;
      const g = c.getContext('2d');
      const BLUE = '#1a6db5', RED = '#cf3126', YEL = '#f7c948';
      if (e.type === 'signdirect') {                             // 指示标志：蓝底白箭头（直行 / 左转 / 右转 / 掉头）
        g.fillStyle = BLUE; g.fillRect(0, 0, 256, 256);
        g.strokeStyle = g.fillStyle = '#fff'; g.lineWidth = 42; g.lineCap = 'round'; g.lineJoin = 'round';
        const st = e.style || 'direct';
        if (st === 'direct') {
          g.beginPath(); g.moveTo(128, 214); g.lineTo(128, 96); g.stroke();
          g.beginPath(); g.moveTo(128, 40); g.lineTo(94, 104); g.lineTo(162, 104); g.closePath(); g.fill();
        } else if (st === 'left' || st === 'right') {
          const dir = st === 'left' ? -1 : 1;                    // 竖杆 128+dir*37、臂端 128-dir*9、尖 128-dir*59：墨迹 x 70..187 居中；纵向 54..201 也居中；箭头底高 38 包住 21 圆头，不会鼓出笔头
          const SX = 128 + dir * 37, AX = 128 - dir * 9, TP = 128 - dir * 59;
          g.beginPath(); g.moveTo(SX, 180); g.lineTo(SX, 92); g.lineTo(AX, 92); g.stroke();
          g.beginPath(); g.moveTo(TP, 92); g.lineTo(AX, 54); g.lineTo(AX, 130); g.closePath(); g.fill();
        } else {                                                // 掉头：上行后弯回向下
          g.beginPath(); g.moveTo(96, 214); g.lineTo(96, 108); g.arc(128, 108, 32, Math.PI, 0); g.lineTo(160, 188); g.stroke();
          g.beginPath(); g.moveTo(160, 230); g.lineTo(130, 176); g.lineTo(190, 176); g.closePath(); g.fill();
        }
      } else if (e.type === 'signspeed') {                        // 限速：白底红圈黑字
        g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
        g.strokeStyle = RED; g.lineWidth = 34; g.beginPath(); g.arc(128, 128, 94, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#141414'; g.font = 'bold 116px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(Math.round(e.limit ?? 60)), 128, 134);
      } else if (e.type === 'signstop') {                         // 停车让行：红底白边八角 + 白「停」
        g.fillStyle = RED; g.beginPath();
        for (let k = 0; k < 8; k++) { const a2 = k * Math.PI / 4 + Math.PI / 8, x = 128 + Math.cos(a2) * 116, y = 128 + Math.sin(a2) * 116; k ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.closePath(); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 12; g.stroke();
        g.fillStyle = '#fff'; g.font = 'bold 128px "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('停', 128, 134);
      } else if (e.type === 'signnoentry') {                      // 禁止驶入：红底白横杠
        g.fillStyle = RED; g.beginPath(); g.arc(128, 128, 110, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.fillRect(36, 106, 184, 44);
      } else if (e.type === 'signwarn') {                         // 注意行人：黄底黑边三角 + 简笔行人（画满画布，与 3D 板形贴合）
        g.fillStyle = YEL; g.strokeStyle = '#161616'; g.lineWidth = 20; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(128, 0); g.lineTo(256, 256); g.lineTo(0, 256); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = g.strokeStyle = '#161616'; g.lineCap = 'round';
        g.beginPath(); g.arc(128, 106, 18, 0, Math.PI * 2); g.fill();          // 头
        g.lineWidth = 18;
        g.beginPath(); g.moveTo(128, 128); g.lineTo(128, 166); g.stroke();      // 躯干
        g.beginPath(); g.moveTo(128, 138); g.lineTo(98, 156); g.moveTo(128, 138); g.lineTo(158, 156); g.stroke();   // 手臂
        g.beginPath(); g.moveTo(128, 166); g.lineTo(108, 202); g.moveTo(128, 166); g.lineTo(148, 202); g.stroke();  // 腿
      } else {                                                    // 指路牌：蓝底白边白字，超长自动缩小
        g.fillStyle = BLUE; g.fillRect(0, 0, 512, 164);
        g.strokeStyle = '#fff'; g.lineWidth = 5; g.strokeRect(9, 9, 494, 146);
        const txt = String(e.text || '主干道');
        g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = `bold ${txt.length > 6 ? 68 : 88}px "Microsoft YaHei", sans-serif`;
        g.fillText(txt, 256, 86);
      }
      const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 4;
      signFaceCache.set(key, tx); return tx;
    }
    const remapShapeUV = geo => {                                // ShapeGeometry 的 UV 是原始 xy 坐标，归一化到 0..1 才能整幅贴图
      geo.computeBoundingBox();
      const bb = geo.boundingBox, pos = geo.attributes.position, uv = geo.attributes.uv;
      const sx = bb.max.x - bb.min.x || 1, sy = bb.max.y - bb.min.y || 1;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) - bb.min.x) / sx, (pos.getY(i) - bb.min.y) / sy);
      uv.needsUpdate = true; return geo;
    };
    let pickWallId = null, pickWallKind = 'wall';                // 当前正在建模的墙 id / kind（门洞墙垛也归属这面墙）
    const tagPick = (o, kind, id) => { if (o && id != null) o.userData.pick3d = { kind, id }; return o; };   // 3D 点击选中标记
    const markNew = (start, kind, id) => { for (let i = start; i < archUp.children.length; i++) { const o = archUp.children[i]; if (!o.userData.pick3d) tagPick(o, kind, id); } };   // 已标记的（如墙垛）保持原归属
    function wallBox([x0, y0, x1, y1], yb, yt, m) {
      if (yt - yb <= .001) return;
      const o = new THREE.Mesh(new THREE.BoxGeometry(M(x1 - x0), yt - yb, M(y1 - y0)), m || [wallMat, wallMat, capMat, wallMat, wallMat, wallMat]);
      o.position.set(wx((x0 + x1) / 2), (yb + yt) / 2, wz((y0 + y1) / 2)); o.castShadow = o.receiveShadow = true; tagPick(o, pickWallKind, pickWallId); archUp.add(o);
      // 漫游辅助：墙体棱线 + 踢脚线，让相邻墙面、墙角一眼可分（仅漫游模式显示）
      const ln = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry), edgeMat); ln.position.copy(o.position); ln.userData.walkOnly = true; ln.visible = opt.mode === 'walk'; archUp.add(ln);
      if (yb <= .001) {
        const p = o.geometry.parameters, sh = Math.min(.12, yt), sk = new THREE.Mesh(new THREE.BoxGeometry(p.width + .02, sh, p.depth + .02), skirtMat);
        sk.position.set(o.position.x, sh / 2, o.position.z); sk.userData.walkOnly = true; sk.visible = opt.mode === 'walk'; archUp.add(sk);
      }
    }
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x6f675b }), skirtMat = new THREE.MeshStandardMaterial({ color: '#8b7f6e', roughness: .6 });
    // ---------- 任意角度的墙段 / 门 / 窗（设计模式画的墙、开的门窗用） ----------
    const wallAngle = (P0, P1) => Math.atan2(-(wz(P1[1]) - wz(P0[1])), wx(P1[0]) - wx(P0[0]));
    const wallMid = (P0, P1) => [wx((P0[0] + P1[0]) / 2), wz((P0[1] + P1[1]) / 2)];
    function pushWallCollider(P0, P1, T, h = H) {              // h：碰撞体顶面高度（米，本层局部）。墙体必须按真实墙高登记，否则单层模式会被当作无限高，爬到楼顶 / 墙顶后仍被墙挡死
      const hh = Math.max(.01, Math.min(H, +h || H)), hw = T / 2, xs = [P0[0] - hw, P0[0] + hw, P1[0] - hw, P1[0] + hw], ys = [P0[1] - hw, P0[1] + hw, P1[1] - hw, P1[1] + hw];
      colliders.push([wx(Math.min(...xs)), wz(Math.min(...ys)), wx(Math.max(...xs)), wz(Math.max(...ys)), 0, hh]);
    }
    const pushSillCollider = (P0, P1, T, dB) => { if (dB > .35) pushWallCollider(P0, P1, T, dB); };   // 门槛 / 龛底矮墙：高过半步才挡路，矮门槛可直接跨过
    function wallSeg3D(P0, P1, T, yb, yt, capTop = true) {   // capTop：墙顶是否用剖面深色（矮墙顶部朝上、会被看到时传 false，避免看起来像一块黑面）
      const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
      if (L < 1 || yt - yb <= .001) return;
      const topMat = capTop ? capMat : wallMat;
      const o = new THREE.Mesh(new THREE.BoxGeometry(M(L), yt - yb, M(T)), [wallMat, wallMat, topMat, wallMat, wallMat, wallMat]);
      const [mx, mz] = wallMid(P0, P1);
      o.position.set(mx, (yb + yt) / 2, mz); o.rotation.y = wallAngle(P0, P1);
      o.castShadow = o.receiveShadow = true; tagPick(o, pickWallKind, pickWallId); archUp.add(o);
      const ln = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry), edgeMat); ln.position.copy(o.position); ln.rotation.copy(o.rotation);
      ln.userData.walkOnly = true; ln.visible = opt.mode === 'walk'; archUp.add(ln);
      if (yb <= .001) {
        const sh = Math.min(.12, yt), sk = new THREE.Mesh(new THREE.BoxGeometry(M(L) + .02, sh, M(T) + .02), skirtMat);
        sk.position.set(mx, sh / 2, mz); sk.rotation.copy(o.rotation);
        sk.userData.walkOnly = true; sk.visible = opt.mode === 'walk'; archUp.add(sk);
      }
    }
    function boxHolesOf(ref, ht) {                              // 电箱暗装洞：wall 上所有电箱的墙面开口（沿墙 c 范围 + 底/顶标高，单位米）
      const g = openingWallGeom(ref); if (!g) return [];
      return [...(state.powerBoxes || []), ...(state.weakBoxes || [])].filter(b => b.wall === ref).map(b => {
        const w = Math.max(200, b.w || 0), de = Math.round(Math.max(60, Math.min(Math.max(120, b.d || 150), g.T - 20)));
        const z0 = Math.max(0, (b.z ?? 1500) / 1000), z1 = Math.min(ht, ((b.z ?? 1500) + (b.h ?? 320)) / 1000);
        return { c0: Math.max(0, (b.c ?? 0) - w / 2), c1: Math.min(g.L, (b.c ?? 0) + w / 2), yb: z0, yt: z1, side: b.side ?? 1, de };
      }).filter(h => h.c1 > h.c0 + 1 && h.yt > h.yb + .01);
    }
    function wallSkin3D(A, B, yb, yt, side, off, thick) {       // 电箱暗装洞的背面墙皮：洞只朝箱门一侧凹进，墙背面不透
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < 1 || yt - yb <= .001) return;
      const nx = -((B[1] - A[1]) / L) * side, ny = ((B[0] - A[0]) / L) * side;
      const o = new THREE.Mesh(new THREE.BoxGeometry(M(L), yt - yb, M(thick)), [wallMat, wallMat, capMat, wallMat, wallMat, wallMat]);
      o.position.set(wx((A[0] + B[0]) / 2 + nx * off), (yb + yt) / 2, wz((A[1] + B[1]) / 2 + ny * off)); o.rotation.y = wallAngle(A, B);
      o.castShadow = o.receiveShadow = true; tagPick(o, pickWallKind, pickWallId); archUp.add(o);
    }
    function wallSegHoles3D(P0, P1, T, ht, holes) {             // 砌墙段时扣掉电箱暗装洞：洞上下保留墙皮，洞背面补墙皮，洞之间砌整墙
      const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
      if (L < 1) return;
      if (!(holes || []).length) { wallSeg3D(P0, P1, T, 0, ht); return; }
      let x = 0;
      holes.slice().sort((a, b) => a.c0 - b.c0).forEach(h => {
        const h0 = Math.max(x, h.c0), h1 = Math.min(L, h.c1); if (h1 <= h0 + 1) return;
        if (h0 > x + 1) { const [a, b] = segPts(P0, P1, x, h0); wallSeg3D(a, b, T, 0, ht); }
        const [a, b] = segPts(P0, P1, h0, h1);
        if (h.yb > .001) wallSeg3D(a, b, T, 0, h.yb);
        if (ht > h.yt + .001) wallSeg3D(a, b, T, h.yt, ht);
        const skin = Math.max(.02, T - (h.de || T));            // 背面墙皮厚度 = 墙厚 - 箱深
        wallSkin3D(a, b, h.yb, h.yt, -(h.side ?? 1), (h.de || T) / 2, skin);
        x = Math.max(x, h1);
      });
      if (x < L - 1) { const [a, b] = segPts(P0, P1, x, L); wallSeg3D(a, b, T, 0, ht); }
    }
    function addDoorLeaf(A, B, o, top, y0 = 0, hgt = Math.min(2.1, top)) {
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = Math.hypot(dx, dy) || 1, u = [dx / L2, dy / L2];
      const side = o.flip ? -1 : 1, n = [-u[1] * side, u[0] * side];
      const ld = o.hflip ? [-u[0], -u[1]] : u;                              // 铰链端决定门扇收拢方向
      const h = [A[0] + u[0] * (o.c + (o.hflip ? o.w : 0)), A[1] + u[1] * (o.c + (o.hflip ? o.w : 0))], L = M(o.w);
      const dh = Math.max(.3, hgt - .05);                                   // 门扇比门洞矮 50mm
      const pivot = new THREE.Group(); pivot.position.set(wx(h[0]), y0, wz(h[1]));
      const dmat = o.mat || 'wood', entryLeaf = isEntry('O' + o.id);
      let leaf, extras = [];
      if (dmat === 'steel') {                                     // 不锈钢门扇
        leaf = box(L, dh, .045, steelMat, L / 2);
      } else if (dmat === 'glass') {                              // 玻璃门扇 + 不锈钢边框
        leaf = box(L, dh, .015, glassMat, L / 2); leaf.userData.pickGlass = true;   // 玻璃门扇允许直接点选
        extras = [
          box(.05, dh, .06, metal(), .025),
          box(.05, dh, .06, metal(), L - .025),
          box(Math.max(.05, L - .10), .06, .06, metal(), L / 2, 0, 0),
          box(Math.max(.05, L - .10), .06, .06, metal(), L / 2, dh - .06, 0),
        ];
      } else {                                                    // 木制门扇
        leaf = box(L, dh, .04, mat(entryLeaf ? '#6b4f3a' : '#efe6d8', { roughness: .5 }), L / 2);
      }
      const knob = new THREE.Mesh(new THREE.SphereGeometry(.03, 12, 8), metal()); knob.position.set(L - .07, Math.max(.35, Math.min(1, dh - .05)), 0); knob.scale.z = 2.2;
      pivot.add(leaf, ...extras, knob);
      const ang = v => Math.atan2(-v[1], v[0]), door = { pivot, a0: ang(ld), a1: ang(n), open: true };
      if (door.a1 - door.a0 > Math.PI) door.a1 -= Math.PI * 2; if (door.a0 - door.a1 > Math.PI) door.a1 += Math.PI * 2;
      door.cur = door.a1; pivot.rotation.y = door.cur; leaf.userData.door = knob.userData.door = door;
      extras.forEach(m => m.userData.door = door);               // 玻璃门扇的边框也能点击开合
      doors.push(door); archUp.add(pivot);
    }
    // 门套：门洞两侧立梃 + 上沿横头（3D 里让门扇有个边框）。PA / PB 为门洞两端平面坐标，y0 / y1 为门槛 / 门顶标高（米）
    // 门套材质跟随门扇：木制用浅木饰面（入户门用门扇同色），不锈钢 / 玻璃用不锈钢边框
    function doorCasingMat(o) {
      if (o && (o.mat === 'steel' || o.mat === 'glass')) return steelMat;
      if (o && (!o.mat || o.mat === 'wood') && isEntry('O' + o.id)) return entryCasingMat;
      return casingMat;
    }
    function addDoorCasing(PA, PB, y0, y1, T, cm = casingMat) {
      const L = M(Math.hypot(PB[0] - PA[0], PB[1] - PA[1]));
      if (L < .2) return;
      const rot = wallAngle(PA, PB), [mx, mz] = wallMid(PA, PB), TT = M(T) + .02, hh = y1 - y0;
      const dx = (wx(PB[0]) - wx(PA[0])) / L, dz = (wz(PB[1]) - wz(PA[1])) / L;
      [-L / 2 + .025, L / 2 - .025].forEach(off => {          // 两侧立梃（50mm 宽，墙面外挑 10mm）
        const post = new THREE.Mesh(new THREE.BoxGeometry(.05, hh, TT), cm);
        post.position.set(mx + dx * off, y0 + hh / 2, mz + dz * off); post.rotation.y = rot; post.castShadow = true; archUp.add(post);
      });
      if (hh > .12) {                                         // 上沿横头（贴门扇上沿，不挡开启）
        const head = new THREE.Mesh(new THREE.BoxGeometry(Math.max(.05, L - .10), .05, TT), cm);
        head.position.set(mx, y1 - .025, mz); head.rotation.y = rot; head.castShadow = true; archUp.add(head);
      }
    }
    // 飘窗可开扇：以 p0（世界坐标，米）为铰链向窗外推开；点 3D 中的玻璃或扇框即可开关
    function addBaySash(p0, p1, yb, wh, ox, oz) {
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1], len = Math.hypot(dx, dz);
      if (len < .12 || wh < .2) return;
      const ux = dx / len, uz = dz / len, rot = Math.atan2(-uz, ux);
      const sgn = (ox * uz - oz * ux) < 0 ? -1 : 1;            // 往窗外那一侧转
      const pg = new THREE.Group();
      pg.position.set(p0[0], 0, p0[1]); pg.rotation.y = rot;
      const sash = { pivot: pg, win: true, open: false, a0: rot, a1: rot + sgn * 1.3, cur: rot, len, y0: yb, y1: yb + wh };   // len / y0 / y1：碰撞按扇宽与玻璃高度区间判定
      const pane = new THREE.Mesh(new THREE.BoxGeometry(len, wh, .014), oneMat(glassMat.clone()));   // 克隆玻璃材质：pick() 跳过原始 glassMat，克隆体才能点击
      pane.position.set(len / 2, yb + wh / 2, 0); pane.userData.door = sash; pg.add(pane);
      const bar = (w, h, x, y) => {                             // 扇框：四边梃
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, .045), frameMat);
        m.position.set(x, yb + y, 0); m.castShadow = true; m.userData.door = sash; pg.add(m);
      };
      bar(.05, wh, .025, wh / 2); bar(.05, wh, len - .025, wh / 2);
      bar(Math.max(.02, len - .1), .04, len / 2, .02); bar(Math.max(.02, len - .1), .04, len / 2, wh - .02);
      const hd = new THREE.Mesh(new THREE.BoxGeometry(.02, .14, .035), metal());   // 开扇侧把手
      hd.position.set(len - .075, yb + Math.max(.3, Math.min(wh - .15, wh * .45)), .03);
      hd.userData.door = sash; pg.add(hd);
      pg.userData.door = sash;
      doors.push(sash); archUp.add(pg);
    }
    function buildRamp3D(s) {                                  // 坡道：斜面踏板 + 两侧挡条（漫游高度由 stairH 按斜面插值）
      const L = s.len / 1000, W = s.w / 1000, H = Math.max(.05, (s.rise ?? 600) / 1000);
      const g = new THREE.Group();
      g.position.set(wx(s.x), 0, wz(s.y)); tagPick(g, 'stair', s.id);
      g.rotation.y = -s.dir * Math.PI / 180 + (s.flipX ? Math.PI : 0);   // 前后翻转 = 整段调头，上行方向反过来
      const ang = Math.atan2(H, L), sl = Math.hypot(L, H), thk = .12;
      const deckMat = mat('#cfc3ac', { roughness: .9 }), curbMat = mat('#8d8069', { roughness: .85 });
      const nx = -Math.sin(ang), ny = Math.cos(ang);           // 坡面法线（局部 x-y 平面）
      const deck = new THREE.Mesh(new THREE.BoxGeometry(sl, thk, W), deckMat);
      deck.position.set(nx * thk / 2, H / 2 - ny * thk / 2, 0); deck.rotation.z = ang;
      deck.castShadow = deck.receiveShadow = true; g.add(deck);
      const fR = s.flipX ? -1 : 1, aR = s.dir * Math.PI / 180, caR = Math.cos(aR), saR = Math.sin(aR);
      const mSeg = Math.max(2, Math.ceil(L / .4));
      for (let i = 1; i <= mSeg; i++) {                        // 坡体底碰撞：每 .4m 一条横向线（y 区间 = 该处坡面高度段，单段升 ≤ .34）：坡底视作实体，漫游不能从坡道下方穿过坡体；坡面上行走高度连续，不受影响
        const xs = -L / 2 * fR + L * fR * i / mSeg, yi = H * i / mSeg, yp = H * (i - 1) / mSeg;
        addBarrier(wx(s.x) + xs * caR - W / 2 * saR, wz(s.y) + xs * saR + W / 2 * caR,
          wx(s.x) + xs * caR + W / 2 * saR, wz(s.y) + xs * saR - W / 2 * caR,
          yp, Math.min(yi, yp + .34), .25, true);
      }
      [-1, 1].forEach(sd => {                                  // 两侧挡条：贴着坡面走
        const c = new THREE.Mesh(new THREE.BoxGeometry(sl, .16, .07), curbMat);
        c.position.set(nx * .08, H / 2 + ny * .08, sd * (W / 2 - .035));
        c.rotation.z = ang; c.castShadow = true; g.add(c);
      });
      if (s.rail) {                                            // 两侧无障碍扶手：3 根立柱 + 沿坡连续扶手管（坡面起 900 高）
        const railMat = mat('#8a939b', { metalness: .5, roughness: .45 });
        [-1, 1].forEach(sd => {
          [-L / 2 + .1, 0, L / 2 - .1].forEach(xLoc => {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, .45, 10), railMat);
            post.position.set(xLoc, H / 2 + Math.tan(ang) * xLoc + .225, sd * (W / 2 - .06));
            post.castShadow = true; g.add(post);
          });
          const bar = new THREE.Mesh(new THREE.BoxGeometry(sl, .045, .045), railMat);
          bar.position.set(nx * .45, H / 2 + ny * .45 + .9, sd * (W / 2 - .06));
          bar.rotation.z = ang; bar.castShadow = true; g.add(bar);
        });
      }
      archUp.add(g);
    }
    function buildLadder3D(s) {                                 // 梯子：两根钢立柱 + 均分踏棍（间距约 300）+ 顶部扶手弯钩（立面朝 +x，攀爬由 ladderClimb 处理）
      const W = s.w / 1000, H = Math.max(.8, (s.h ?? 3000) / 1000);
      const g = new THREE.Group();
      g.position.set(wx(s.x), 0, wz(s.y)); tagPick(g, 'stair', s.id);
      g.rotation.y = -s.dir * Math.PI / 180;
      const steel = mat('#9aa2ab', { metalness: .6, roughness: .4 });
      const nR = Math.max(3, Math.round(H / .3)), dy = H / nR;
      [-1, 1].forEach(sd => {                                   // 两侧立柱 + 顶部扶手弯钩（伸向背面 = 跨上方向）
        const post = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, H, 10), steel);
        post.position.set(0, H / 2, sd * (W / 2 - .05)); post.castShadow = true; g.add(post);
        const hook = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, .42, 10), steel);
        hook.rotation.z = Math.PI / 2;
        hook.position.set(-.19, H + .02, sd * (W / 2 - .05)); hook.castShadow = true; g.add(hook);
      });
      for (let k = 0; k < nR; k++) {                            // 踏棍：横跨梯宽的圆管（轴向沿局部 z，连接两根立柱），间距均分
        const rung = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, W - .1, 8), steel);
        rung.rotation.x = Math.PI / 2;
        rung.position.set(0, (k + .5) * dy, 0); rung.castShadow = true; g.add(rung);
      }
      const caL = Math.cos(s.dir * Math.PI / 180), saL = Math.sin(s.dir * Math.PI / 180);   // 梯身带高度线段碰撞（线沿梯宽方向，局部 z 两端）：拦住穿梯身（含侧面），攀爬贴近不受影响
      addBarrier(wx(s.x) + W / 2 * saL, wz(s.y) - W / 2 * caL, wx(s.x) - W / 2 * saL, wz(s.y) + W / 2 * caL, 0, H, .1);
      archUp.add(g);
    }
    function escRailSize(s, ny) {                                 // 自动扶梯围栏高度（垂直）：梯段扶手中心与平台扶手取同一标高
      const h = Math.max(.4, Math.min(1.2, (s.fenceH ?? 1200) / 1000));
      const dRail = Math.max(.4, Math.min(1.6, h / Math.max(.35, ny)));
      const railH = Math.max(.36, dRail - .038);
      return { railH, dRail, h };
    }
    function escRailLink(g, a, b, railMat, overlap = .06) {       // 扶手带 / 平台围栏之间的矩形搭接段：按三维端点自动定向，截面与扶手带一致
      const A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
      const d = new THREE.Vector3().subVectors(B, A), L = d.length();
      if (L < .09) return;
      const m = new THREE.Mesh(new THREE.BoxGeometry(L + overlap, .075, .1), railMat);
      m.position.copy(A).add(B).multiplyScalar(.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize());
      m.castShadow = true; g.add(m);
    }
    function escLoopPos(e, t) {                                 // 自动扶梯梯级闭环取位：0..Lr 骑行斜面（梯面保持水平）→ 端部圆弧回转翻转 180°（沉入端部楼板之下）→ 骑行面下方 2R 处倒挂平行回程 → 另一端圆弧回转复位，全程切线连续、沿弧长匀速，形成真实连贯的循环转动。r 为绕 z 俯仰角；k 为转弯方向（按行进 x 向取号，保证回程始终在骑行面下方）
      const Lr = e.Lr, Re = e.Re, arc = Math.PI * Re;
      const ux = (e.x1 - e.x0) / Lr, uy = (e.y1 - e.y0) / Lr, th = Math.atan2(e.y1 - e.y0, e.x1 - e.x0), k = ux > 0 ? -1 : 1;
      const nx = -uy * k, ny = ux * k;                        // 回程线相对骑行面的偏移方向（ny 恒 < 0）
      if (t < Lr) return { x: e.x0 + ux * t, y: e.y0 + uy * t, r: 0 };
      if (t < Lr + arc) {
        const f = (t - Lr) / Re, a = th - k * Math.PI / 2 + k * f;
        return { x: e.x1 + nx * Re + Math.cos(a) * Re, y: e.y1 + ny * Re + Math.sin(a) * Re, r: k * f };
      }
      if (t < 2 * Lr + arc) {
        const d2 = t - Lr - arc;
        return { x: e.x1 + nx * 2 * Re - ux * d2, y: e.y1 + ny * 2 * Re - uy * d2, r: k * Math.PI };
      }
      const f = (t - 2 * Lr - arc) / Re, a = th + k * Math.PI / 2 + k * f;
      return { x: e.x0 + nx * Re + Math.cos(a) * Re, y: e.y0 + ny * Re + Math.sin(a) * Re, r: k * (Math.PI + f) };
    }
    function buildEsc3D(s) {                                    // 自动扶梯：两侧窄桁架梁（中间镂空露出梯级）+ 半透明玻璃栏板（底边贴梯级斜面）+ 顶部黑色扶手带与两端回转端头 + 循环上行的水平梯级（漫游高度由 stairH 沿斜面插值）
      const lay0 = stairLayout(s);
      if (lay0.runs.length > 1) return buildEscMulti3D(s, lay0);   // 多跑扶梯（双跑折返 / 双向一上一下）：两段扶梯，单独生成
      const L = s.len / 1000, W = s.w / 1000, H = Math.max(.05, (s.rise ?? 2400) / 1000);
      const hasLand = lay0.lands.length > 0, Lr = hasLand ? L - W : L, off = hasLand ? -W / 2 : 0;   // 有末端平台时梯段缩短 W（平台占高端 W + 压 200），梯段几何放子组整体平移
      const g = new THREE.Group();
      g.position.set(wx(s.x), 0, wz(s.y)); tagPick(g, 'stair', s.id);
      g.rotation.y = -s.dir * Math.PI / 180 + (s.flipX ? Math.PI : 0);   // 前后翻转 = 整段调头，上行方向反过来
      const sub = new THREE.Group(); sub.position.x = off; g.add(sub);
      const ang = Math.atan2(H, Lr), sl = Math.hypot(Lr, H);
      const nx = -Math.sin(ang), ny = Math.cos(ang);
      const metal = mat('#9aa2ab', { metalness: .55, roughness: .45 }),
        tread = mat('#565d66', { roughness: .8 }), comb = mat('#c9a44a', { roughness: .6 });
      const railMat = ({ black: mat('#34383d', { roughness: .7 }), steel: mat('#b9c0c8', { metalness: .75, roughness: .28 }), wood: mat('#8a6a48', { roughness: .6 }) })[s.handMat] || mat('#34383d', { roughness: .7 });   // 扶手带材质：黑色橡胶（默认）/ 不锈钢 / 木纹
      const glass = mat('#c3d2d8', { metalness: .1, roughness: .2, transparent: true, opacity: .3, depthWrite: false });
      const panelMat = ({ glass, steel: mat('#b9c0c8', { metalness: .75, roughness: .3 }), wood: mat('#8a6a48', { roughness: .6 }) })[s.panelMat] || glass;   // 围挡（栏板）材质：半透明玻璃（默认）/ 不锈钢板 / 木板
      const { railH, dRail, h: fenceHm } = escRailSize(s, ny);    // 梯段栏板 / 扶手高度由围栏高度设置换算
      [-1, 1].forEach(sd => {
        const skH = Math.max(.2, Math.min(2, (s.skirtH ?? 900) / 1000)), skD = (skH - .24) / 2;   // 下护板：高度可调（默认 900mm），顶边固定在原桁架梁上沿（斜面下方），只向下延伸，不遮住上方玻璃栏板
        const beam = new THREE.Mesh(new THREE.BoxGeometry(sl, skH, .07), metal);
        beam.position.set(nx * (.16 - skD), H / 2 - ny * (.16 + skD), sd * (W / 2 - .05)); beam.rotation.z = ang;
        beam.castShadow = beam.receiveShadow = true; sub.add(beam);
        if (lay0.lands.length) {                              // 高端护板顶边接到末端平台板，消除护板与平台之间的空档
          const cH = Math.max(.2, Math.min(2, (s.platSkirtH ?? 900) / 1000)), cY = Math.max(.12, lay0.lands[0].y / 1000) + .15 - cH / 2;   // 高度与平台下护板一致
          const con = new THREE.Mesh(new THREE.BoxGeometry(.3, cH, .07), metal);
          con.position.set(Lr / 2 + .075, cY, sd * (W / 2 - .05)); con.castShadow = true; sub.add(con);
        }
        const panel = new THREE.Mesh(new THREE.BoxGeometry(sl, railH, .035), panelMat);   // 围挡栏板：中心沿法线抬半个高度，底边正好贴斜面
        panel.position.set(nx * railH / 2, H / 2 + ny * railH / 2, sd * (W / 2 - .018)); panel.rotation.z = ang;
        sub.add(panel);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(sl, .075, .1), railMat);   // 扶手带：紧贴栏板顶边，不悬空
        rail.position.set(nx * dRail, H / 2 + ny * dRail, sd * (W / 2 - .018)); rail.rotation.z = ang;
        rail.castShadow = true; sub.add(rail);
        const linkToLand = lay0.lands.length && s.railLand !== false && (s.fenceSide || 'all') !== 'end';
        [-1, 1].forEach(e => {                                 // 两端扶手水平回转段 + 圆端头；高端有平台侧栏时改由搭接段续接，避免多出一截端头
          if (e > 0 && linkToLand) return;
          const x0 = e * Lr / 2 + nx * dRail, y0 = (e < 0 ? 0 : H) + ny * dRail;
          const hr = new THREE.Mesh(new THREE.BoxGeometry(.36, .075, .1), railMat);
          hr.position.set(x0 + e * .18, y0, sd * (W / 2 - .018)); hr.castShadow = true; sub.add(hr);
          const cap = new THREE.Mesh(new THREE.SphereGeometry(.052, 10, 8), railMat);
          cap.position.set(x0 + e * .36, y0, sd * (W / 2 - .018)); sub.add(cap);
        });
      });
      const Re = .3, arc = Math.PI * Re, S = 2 * Lr + 2 * arc, n = Math.max(6, Math.round(S / .4)), pitch = S / n;   // 梯级沿闭环均布（骑行段密度仍约 400mm）：闭环 = 骑行斜面 + 两端回转圆弧（半径 300mm）+ 斜面下方倒挂回程
      for (let i = 0; i < n; i++) {
        const st = new THREE.Group();
        const t1 = new THREE.Mesh(new THREE.BoxGeometry(.38, .035, W * .84), tread);   // 踏面
        t1.castShadow = t1.receiveShadow = true;
        const edge = new THREE.Mesh(new THREE.BoxGeometry(.035, .038, W * .84), comb);  // 前缘黄色安全边
        edge.position.x = -.17;
        const t2 = new THREE.Mesh(new THREE.BoxGeometry(.025, .19, W * .84), metal);    // 立面（朝下行方向）
        t2.position.set(-.19, -.1, 0);
        st.add(t1, t2, edge);
        st.userData.esc = { i, pitch, S, Lr, Re, x0: -Lr / 2, y0: 0, x1: Lr / 2, y1: H };   // 闭环路径：骑行面两端即两端梳齿板位置，回转圆弧沉入端部平台 / 楼板之下，主循环按弧长匀速取位并连续俯仰
        sub.add(st); escSteps.push(st);
      }
      const aDir = s.dir * Math.PI / 180, caD = Math.cos(aDir), saD = Math.sin(aDir), fD = s.flipX ? -1 : 1;
      const lx0 = off - Lr / 2 * fD, lx1 = off + Lr / 2 * fD;   // 低端（y=0）与高端（y=H）平面局部坐标（含平台偏移，与 stairH 插值同一约定）
      [-1, 1].forEach(sd => {                                  // 两侧玻璃栏板 / 桁架：带高度线段碰撞，漫游不能横穿扶梯侧身，站梯面边缘也不会侧向掉出
        const zl = sd * (W / 2 - .02);
        addBarrier(wx(s.x) + lx0 * caD - zl * saD, wz(s.y) + lx0 * saD + zl * caD,
          wx(s.x) + lx1 * caD - zl * saD, wz(s.y) + lx1 * saD + zl * caD,
          0, H + railH, .18);
      });
      for (let i = 1; i <= n; i++) {                           // 底部桁架碰撞：每级梯级一条横向线（y 区间 = 该级踢面段，超出 .34 收缩）——不能从扶梯下方水平穿入梯段；梯面上因单级升 ≤ 可跨步高 .35，通行与传送不受影响
        const xs = lx0 + (lx1 - lx0) * i / n, yi = H * i / n, yp = H * (i - 1) / n;
        addBarrier(wx(s.x) + xs * caD - W / 2 * saD, wz(s.y) + xs * saD + W / 2 * caD,
          wx(s.x) + xs * caD + W / 2 * saD, wz(s.y) + xs * saD - W / 2 * caD,
          yp, Math.min(yi, yp + .34), .25, true);
      }
      if (lay0.lands.length) {                                 // 末端平台：实心楼板（组局部内边距梯级端头 150mm，外伸宽度由属性面板 landOut 决定），顶面抬高 150mm，前后翻转由组旋转承担 + 底部实体碰撞；围栏抬高 180mm
        const py = Math.max(.12, lay0.lands[0].y / 1000), pyT = py + .15, pyF = py + .18;
        const lo = Math.max(.6, Math.min(3, (s.landOut ?? 1500) / 1000)), pxIn = L / 2 - W + .15, pxOut = pxIn + lo, pw = lo;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(pw, .12, W), metal);
        slab.position.set((pxIn + pxOut) / 2, pyT - .06, 0); slab.castShadow = slab.receiveShadow = true; g.add(slab);
        const psH = Math.max(.2, Math.min(2, (s.platSkirtH ?? 900) / 1000)), psY = pyT - psH / 2;   // 平台下护板：外端 + 两侧三面围住（高度同平台下护板设置），朝台阶的内侧留空
        const endPanel = new THREE.Mesh(new THREE.BoxGeometry(.07, psH, W), metal);
        endPanel.position.set(pxOut - .035, psY, 0); endPanel.castShadow = true; g.add(endPanel);
        [-1, 1].forEach(sd => {
          const sidePanel = new THREE.Mesh(new THREE.BoxGeometry(lo, psH, .07), metal);
          sidePanel.position.set((pxIn + pxOut) / 2, psY, sd * (W / 2 - .035)); sidePanel.castShadow = true; g.add(sidePanel);
        });
        const c0 = [wx(s.x) + pxIn * caD, wz(s.y) + pxIn * saD], c1 = [wx(s.x) + pxOut * caD, wz(s.y) + pxOut * saD];
        colliders.push([Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1]), 0, pyT]);
        if (s.railLand !== false) {                            // 平台围栏：扶手与斜段扶手同高，外端 + 两侧悬空边（接梯段的一边不围）
          let fRailY = py + fenceHm;                            // 平台扶手标高与梯段扶手终点一致（同一基准标高 + 围栏高度）
          const fPanelH = Math.max(.05, fRailY - pyF - .038);
          fRailY = pyF + fPanelH + .038;
          const fence = (x0, z0, x1, z1) => {
            const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, len3 = Math.hypot(x1 - x0, z1 - z0), ry = -Math.atan2(z1 - z0, x1 - x0);
            const pn = new THREE.Mesh(new THREE.BoxGeometry(len3, fPanelH, .035), panelMat);
            pn.position.set(cx, pyF + fPanelH / 2, cz); pn.rotation.y = ry; g.add(pn);
            const rl = new THREE.Mesh(new THREE.BoxGeometry(len3, .075, .1), railMat);
            rl.position.set(cx, fRailY, cz); rl.rotation.y = ry; rl.castShadow = true; g.add(rl);
            const w0 = [wx(s.x) + x0 * caD - z0 * saD, wz(s.y) + x0 * saD + z0 * caD], w1 = [wx(s.x) + x1 * caD - z1 * saD, wz(s.y) + x1 * saD + z1 * caD];
            addBarrier(w0[0], w0[1], w1[0], w1[1], 0, pyF + fPanelH, .18);
          };
          const fs = s.fenceSide || 'all';
          const fx = pxIn - .05, fxe = pxOut - .05;           // 围栏随平台板宽度走（两端各内缩 50mm）
          if (fs !== 'sides') fence(fxe, -W / 2, fxe, W / 2);
          if (fs !== 'end') { fence(fx, -W / 2, fxe, -W / 2); fence(fx, W / 2, fxe, W / 2); }
          if (fs !== 'end') [-1, 1].forEach(sd => {           // 「仅外端」两侧无栏板，扶手在梯段高端已圆端头收口，平台侧不再搭接悬空扶手
            const xRail = off + Lr / 2 + nx * dRail, yRail = H + ny * dRail, zRail = sd * (W / 2 - .018);
            const tx = Math.max(fx, Math.min(fxe, xRail));
            escRailLink(g, [xRail, yRail, zRail], [tx, yRail, zRail], railMat, .02);
            escRailLink(g, [tx, yRail, zRail], [tx, fRailY, sd * W / 2], railMat, .04);
          });
        }
      }
      archUp.add(g);
    }
    function buildEscMulti3D(s, lay) {                          // 多跑自动扶梯（双跑折返 / 双向一上一下）：两段扶梯（桁架 + 栏板 + 扶手带 + 梳齿 + 循环梯级）+ 折返平台（双向无平台），材质与单跑一致
      const W = s.w / 1000, H = Math.max(.05, (s.rise ?? 2400) / 1000);
      const g = new THREE.Group();
      g.position.set(wx(s.x), 0, wz(s.y)); tagPick(g, 'stair', s.id);
      g.rotation.y = -s.dir * Math.PI / 180;                  // 前后 / 左右翻转已在 stairLayout 的 runs 坐标里处理
      const metal = mat('#9aa2ab', { metalness: .55, roughness: .45 }),
        tread = mat('#565d66', { roughness: .8 }), comb = mat('#c9a44a', { roughness: .6 });
      const railMat = ({ black: mat('#34383d', { roughness: .7 }), steel: mat('#b9c0c8', { metalness: .75, roughness: .28 }), wood: mat('#8a6a48', { roughness: .6 }) })[s.handMat] || mat('#34383d', { roughness: .7 });
      const glass = mat('#c3d2d8', { metalness: .1, roughness: .2, transparent: true, opacity: .3, depthWrite: false });
      const panelMat = ({ glass, steel: mat('#b9c0c8', { metalness: .75, roughness: .3 }), wood: mat('#8a6a48', { roughness: .6 }) })[s.panelMat] || glass;
      const fenceHm = Math.max(.4, Math.min(1.2, (s.fenceH ?? 1200) / 1000));
      const aDir = s.dir * Math.PI / 180, caD = Math.cos(aDir), saD = Math.sin(aDir);
      const toW = (lx, lz) => [wx(s.x) + lx * caD - lz * saD, wz(s.y) + lx * saD + lz * caD];   // 局部 → 世界（毫米局部）
      const inLand = (L, xe, yl) => Math.abs(L.y / 1000 - yl) < .02 && xe >= Math.min(L.x0, L.x1) / 1000 - .001 && xe <= Math.max(L.x0, L.x1) / 1000 + .001;
      const nearLand = (L, xe, yl) => Math.abs(L.y / 1000 - yl) < .02 && xe >= Math.min(L.x0, L.x1) / 1000 - .25 && xe <= Math.max(L.x0, L.x1) / 1000 + .25;
      const arr = lay.lands.map(() => []);                   // 各平台上扶手带真实端头（含法向偏移）：平台内边距梯段端头 150mm，按 250mm 容差认作接口，再用搭接段连到平台围栏
      lay.runs.forEach((r, ri) => {
        const xLo = r.x0 / 1000, xHi = r.x1 / 1000, ya0 = r.y0 / 1000, yb0 = r.y1 / 1000;
        const Lr = Math.abs(xHi - xLo), Hy = Math.max(.05, Math.abs(yb0 - ya0)), sgn = (yb0 - ya0) * (xHi - xLo) > 0 ? 1 : -1;   // 坡向：上行跑 +1，折返 / 下行跑 -1
        const ang = Math.atan2(Hy, Lr) * sgn, nx = -Math.sin(ang), ny = Math.cos(ang);
        [[xLo, ya0], [xHi, yb0]].forEach(([xe, yl], ei) => {
          const li = lay.lands.findIndex(L => nearLand(L, xe, yl));
          if (li < 0) return;                                // 该端不靠任何平台（落地端）
          const cut = lay.lands.some(L => inLand(L, xe, yl)) ? .2 : 0;   // 平台板真正压住梯段端头时才收边 200；现有布局留 150mm 缝，扶手直接伸到接口
          const inward = ei === 0 ? Math.sign(xHi - xLo) || 1 : Math.sign(xLo - xHi) || 1;
          const dRailR = escRailSize(s, ny).dRail;
          const xEnd = xe + inward * cut + nx * dRailR, yEnd = yl - Hy * cut / Lr + ny * dRailR;   // 扶手带真实端头（与斜段几何同一算法）
          [-1, 1].forEach(sd => arr[li].push({ z: r.z / 1000 + sd * (W / 2 - .018), x: xEnd, y: yEnd, run: ri }));
        });
      });
      lay.runs.forEach(r => {
        const xLo = r.x0 / 1000, xHi = r.x1 / 1000;         // 低端（y0）恒为 x0、高端（y1）恒为 x1——与 stairH / escCarry 插值同一约定，第二跑折返后低端在远端
        const z = r.z / 1000, ya = r.y0 / 1000, yb = r.y1 / 1000, Lr = Math.abs(xHi - xLo), Hy = Math.max(.05, Math.abs(yb - ya)), sgn = (yb - ya) * (xHi - xLo) > 0 ? 1 : -1;
        const ang = Math.atan2(Hy, Lr) * sgn, nx = -Math.sin(ang), ny = Math.cos(ang), cx = (xLo + xHi) / 2, cy = (ya + yb) / 2;   // 角度按坡向取正负（折返跑 / 下行跑为负角）：长轴沿坡面，法线自动朝上
        const lowFirst = xHi > xLo;                         // 低端是否在 x 较小的一侧（第二跑折返后不成立）
        const xA = Math.min(xLo, xHi), xB = Math.max(xLo, xHi);
        const onLand = (xe, yl) => lay.lands.some(L => Math.abs(L.y / 1000 - yl) < .02 && xe >= Math.min(L.x0, L.x1) / 1000 - .001 && xe <= Math.max(L.x0, L.x1) / 1000 + .001);
        const tLo = onLand(xLo, ya) ? .2 : 0, tHi = onLand(xHi, yb) ? .2 : 0;   // 端头压在折返平台板下的 200mm（平台向梯段端头压 200 盖缝）不再画栏板与扶手带，扶手收在平台边缘
        const cutA = lowFirst ? tLo : tHi, cutB = lowFirst ? tHi : tLo;         // cutA 收左端 / cutB 收右端
        const Lr2 = Lr - cutA - cutB, sl = Math.hypot(Lr2, Hy * Lr2 / Lr);      // 收边后的栏板 / 扶手长度（坡度不变）
        const mx = cx + (cutA - cutB) / 2, my = cy + Math.tan(ang) * (cutA - cutB) / 2;   // 收边后的中点（沿斜段平移）
        const eA = lowFirst ? ya + Hy * tLo / Lr : yb - Hy * tHi / Lr, eB = lowFirst ? yb - Hy * tHi / Lr : ya + Hy * tLo / Lr;   // 左右两端收边处的梯面标高
        const { railH: railHR, dRail: dRailR } = escRailSize(s, ny);
        [-1, 1].forEach(sd => {
          const skH = Math.max(.2, Math.min(2, (s.skirtH ?? 900) / 1000)), skD = (skH - .24) / 2;   // 下护板默认 900mm，顶边固定，只向下延伸，不遮住玻璃栏板
          const beam = new THREE.Mesh(new THREE.BoxGeometry(sl, skH, .07), metal);
          beam.position.set(mx + nx * (.16 - skD), my - ny * (.16 + skD), z + sd * (W / 2 - .05)); beam.rotation.z = ang; beam.castShadow = beam.receiveShadow = true; g.add(beam);
          const panel = new THREE.Mesh(new THREE.BoxGeometry(sl, railHR, .035), panelMat);
          panel.position.set(mx + nx * railHR / 2, my + ny * railHR / 2, z + sd * (W / 2 - .018)); panel.rotation.z = ang; g.add(panel);
          const rail = new THREE.Mesh(new THREE.BoxGeometry(sl, .075, .1), railMat);
          rail.position.set(mx + nx * dRailR, my + ny * dRailR, z + sd * (W / 2 - .018)); rail.rotation.z = ang; rail.castShadow = true; g.add(rail);
          [[xA + cutA, eA], [xB - cutB, eB]].forEach(([ec, ey]) => {       // 平台端护板顶边接到平台板，消除护板与平台之间的空档
            const L = lay.lands.find(q => Math.abs(q.y / 1000 - ey) < .2 && ec >= Math.min(q.x0, q.x1) / 1000 - .6 && ec <= Math.max(q.x0, q.x1) / 1000 + .6);
            if (!L) return;
            const to = (Math.min(L.x0, L.x1) + Math.max(L.x0, L.x1)) / 2000 > ec ? 1 : -1;
            const cH = Math.max(.2, Math.min(2, (s.platSkirtH ?? 900) / 1000)), cY = Math.max(.12, L.y / 1000) + .15 - cH / 2;   // 高度与平台下护板一致
            const con = new THREE.Mesh(new THREE.BoxGeometry(.3, cH, .07), metal);
            con.position.set(ec + to * .075, cY, z + sd * (W / 2 - .05)); con.castShadow = true; g.add(con);
          });
          [[xA + cutA, eA], [xB - cutB, eB]].forEach(([ec, ey], ei) => {   // 端头收尾：平台端扶手带收到平台边缘即止（由平台上的连接围栏续接，不再加立柱悬在半空），落地端仍做水平回转段 + 圆端头
            const out = ei === 0 ? -1 : 1, atLand = (ei === 0 ? cutA : cutB) > 0;
            if (atLand) return;
            const ex = ec + nx * dRailR;                    // 扶手带真实端头：斜段整体沿法线偏移过，端头也要带同一偏移，否则回转段与扶手带脱开
            const hr = new THREE.Mesh(new THREE.BoxGeometry(.36, .075, .1), railMat);
            hr.position.set(ex + out * .18, ey + ny * dRailR, z + sd * (W / 2 - .018)); hr.castShadow = true; g.add(hr);
            const cap = new THREE.Mesh(new THREE.SphereGeometry(.052, 10, 8), railMat);
            cap.position.set(ex + out * .36, ey + ny * dRailR, z + sd * (W / 2 - .018)); g.add(cap);
          });
          const [b0, b1] = [toW(r.x0 / 1000, r.z / 1000 + sd * (W / 2 - .02)), toW(r.x1 / 1000, r.z / 1000 + sd * (W / 2 - .02))];   // 栏板碰撞（米坐标）：拦住横穿扶梯侧身
          addBarrier(b0[0], b0[1], b1[0], b1[1], ya, yb + railHR, .18);
        });
        const Re = .3, arc = Math.PI * Re, S = 2 * Lr + 2 * arc, n = Math.max(6, Math.round(S / .4)), pitch = S / n;   // 梯级沿闭环均布（骑行段密度仍约 400mm）：闭环 = 骑行斜面 + 两端回转圆弧（半径 300mm）+ 斜面下方倒挂回程
        for (let i = 0; i < n; i++) {
          const st = new THREE.Group();
          const t1 = new THREE.Mesh(new THREE.BoxGeometry(.38, .035, W * .84), tread); t1.castShadow = t1.receiveShadow = true;
          const edge = new THREE.Mesh(new THREE.BoxGeometry(.035, .038, W * .84), comb); edge.position.x = -.17;
          const t2 = new THREE.Mesh(new THREE.BoxGeometry(.025, .19, W * .84), metal); t2.position.set(-.19, -.1, 0);
          st.add(t1, t2, edge);
          if ((yb - ya) * (xHi - xLo) < 0) st.scale.x = -1;   // 沿行进方向下行（双向的下行跑 / 折返跑反向段）：镜像梯级，立面 / 前缘仍贴下坡一侧（俯仰由主循环按闭环统一驱动）
          st.userData.esc = { i, pitch, S, Lr, Re, x0: xLo, y0: ya, x1: xHi, y1: yb, z };   // 闭环路径：骑行面两端即两端梳齿位置，回转圆弧沉入端部楼板之下
          g.add(st); escSteps.push(st);
        }
        for (let i = 1; i <= n; i++) {                        // 底部实体碰撞：每级一条横向线（y 区间 = 该级踢面段，超出 .34 收缩）——不能从扶梯下方水平穿入；梯面上单级升 ≤ 可跨步高不受影响
          const xs2 = xLo + (xHi - xLo) * i / n, yi = ya + (yb - ya) * i / n, yp = ya + (yb - ya) * (i - 1) / n;   // 下行跑 yb < ya，按带符号坡度插值
          const [q0, q1] = [toW(xs2, r.z / 1000 - s.w / 2000), toW(xs2, r.z / 1000 + s.w / 2000)];
          addBarrier(q0[0], q0[1], q1[0], q1[1], yp, Math.min(yi, yp + .34), .25, true);
        }
      });
      lay.lands.forEach((L, li) => {                          // 折返平台：实心楼板 + 楼板式碰撞（只挡板体；平台板顶面抬高 150mm、整体外移 350mm 已在 stairLayout 矩形里；角点经朝向旋转换算，dir 为 90° 倍数时 AABB 仍轴对齐）——近端平台下方是另一跑的起步区，不能做成落地实体
        const px = (L.x0 + L.x1) / 2, pz = (L.z0 + L.z1) / 2, pw = Math.max(0, (L.x1 - L.x0) / 1000), pd = Math.max(0, (L.z1 - L.z0) / 1000), py = Math.max(.12, L.y / 1000), pyT = py + .15, pyF = py + .18;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(pw, .12, pd), metal);
        slab.position.set(px / 1000, pyT - .06, pz / 1000); slab.castShadow = slab.receiveShadow = true; g.add(slab);
        const xaP = Math.min(L.x0, L.x1) / 1000, xbP = Math.max(L.x0, L.x1) / 1000, xOut = Math.abs(L.x0) > Math.abs(L.x1) ? xaP : xbP;   // 平台下护板：外端 + 两侧三面围住，朝台阶的一面留空
        const psH = Math.max(.2, Math.min(2, (s.platSkirtH ?? 900) / 1000)), psY = pyT - psH / 2;
        const endPanel = new THREE.Mesh(new THREE.BoxGeometry(.07, psH, pd), metal);
        endPanel.position.set(xOut, psY, pz / 1000); endPanel.castShadow = true; g.add(endPanel);
        [-1, 1].forEach(sd => {
          const sidePanel = new THREE.Mesh(new THREE.BoxGeometry(pw, psH, .07), metal);
          sidePanel.position.set(px / 1000, psY, pz / 1000 + sd * (pd / 2 - .035)); sidePanel.castShadow = true; g.add(sidePanel);
        });
        const c0 = toW(L.x0 / 1000, L.z0 / 1000), c1 = toW(L.x1 / 1000, L.z1 / 1000);
        colliders.push([Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1]), Math.max(0, pyT - .12), pyT]);
        if (s.railLand !== false) {                           // 平台围栏：扶手与斜段扶手同高；外露 x 边 + 两侧悬空边，接入边加横向扶手把各跑扶手连成一圈
          const xa0 = Math.min(L.x0, L.x1) / 1000, xb0 = Math.max(L.x0, L.x1) / 1000, fs = s.fenceSide || 'all';
          const fSh = xa0 + xb0 > 0 ? -.05 : .05;             // 平台板外移 350mm，围栏只外移 300mm（回退 50mm）
          const xa = xa0 + fSh, xb = xb0 + fSh, za = L.z0 / 1000, zb = L.z1 / 1000;
          let railY = py + fenceHm;                            // 平台扶手标高与梯段扶手终点一致（同一基准标高 + 围栏高度）
          const fPanelH = Math.max(.05, railY - pyF - .038);
          railY = pyF + fPanelH + .038;
          const fence = (x0, z0, x1, z1, th = .035) => {
            const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, len3 = Math.hypot(x1 - x0, z1 - z0), ry = -Math.atan2(z1 - z0, x1 - x0);
            const pn = new THREE.Mesh(new THREE.BoxGeometry(len3, fPanelH, th), panelMat);
            pn.position.set(cx, pyF + fPanelH / 2, cz); pn.rotation.y = ry; g.add(pn);
            const rl = new THREE.Mesh(new THREE.BoxGeometry(len3, .075, Math.max(th, .1)), railMat);
            rl.position.set(cx, railY, cz); rl.rotation.y = ry; rl.castShadow = true; g.add(rl);
            const [w0, w1] = [toW(x0, z0), toW(x1, z1)];
            addBarrier(w0[0], w0[1], w1[0], w1[1], pyF - .12, pyF + fPanelH, .18);   // 碰撞只覆盖平台板体以上（与楼板碰撞同底），不能从地面立起
          };
          const xOut = Math.abs(xa0) > Math.abs(xb0) ? xa : xb;
          if (fs !== 'sides') fence(xOut, za, xOut, zb);           // 外端：四周 / 仅外端
          if (fs !== 'end') { fence(xa, za, xb, za); fence(xa, zb, xb, zb); }   // 两侧：四周 / 仅两侧
          const edgeX = Math.abs(xa0) < Math.abs(xb0) ? xa : xb;   // 梯段接入的那条平台边
          const ends = (arr[li] || []).slice().sort((a, b) => a.z - b.z);
          // 扶手只搭接在实际画出的围栏上：两侧 / 四周时侧边有栏板可依附；「仅外端」两侧无栏板，扶手在平台边圆端头收口，不架悬空段
          ends.forEach(p => {
            const sideZ = Math.abs(p.z - za) < Math.abs(p.z - zb) ? za : zb;
            if (fs !== 'end' && Math.abs(p.z - sideZ) < .3) {               // 外侧扶手：仅两侧 / 四周时侧边有栏板，沿侧边搭接，不占中间通道
              const tx = Math.max(xa, Math.min(xb, p.x));
              escRailLink(g, [p.x, p.y, p.z], [tx, p.y, p.z], railMat, .02);
              escRailLink(g, [tx, p.y, p.z], [tx, railY, sideZ], railMat, .04);
            } else {                                                        // 内侧扶手 /「仅外端」两侧：平台不设侧栏板，圆端头收口
              const cap = new THREE.Mesh(new THREE.SphereGeometry(.052, 10, 8), railMat);
              cap.position.set(p.x, p.y, p.z); g.add(cap);
            }
          });
          if (fs !== 'end') {                                               // 接入边补空档护栏：扣掉各跑占用宽度带，剩余净空 ≥0.12 才补
            let free = [[za, zb]];
            lay.runs.forEach(r => {
              if (Math.abs(r.x0 / 1000 - edgeX) > .25 && Math.abs(r.x1 / 1000 - edgeX) > .25) return;   // 平台向梯段端头压 200mm，按 0.25 容差匹配梯段端
              const a = r.z / 1000 - W / 2, b = r.z / 1000 + W / 2;
              free = free.flatMap(([p, q]) => {
                const out = [];
                if (a > p) out.push([p, Math.min(a, q)]);
                if (b < q) out.push([Math.max(b, p), q]);
                return out;
              });
            });
            free.forEach(([p, q]) => { if (q - p > .12) fence(edgeX, p, edgeX, q); });
          }
        }
      });
      archUp.add(g);
    }
    function buildSpiral3D(s) {                                 // 螺旋楼梯：中心柱 + 绕柱楔形踏步 + 外缘螺旋扶手
      const lay = stairLayout(s), n = lay.nStep, R = lay.rOuter / 1000, rc = lay.rCore / 1000;
      const H = Math.max(.03, (s.rise ?? 2800) / 1000), stepH = H / n, dA = lay.ang / n;
      const g = new THREE.Group();
      g.position.set(wx(s.x), 0, wz(s.y)); tagPick(g, 'stair', s.id);
      g.rotation.y = -s.dir * Math.PI / 180 + (s.flipX ? Math.PI : 0);
      const treadMat = mat('#c9bda6', { roughness: .9 }), poleMat = mat('#8d8069', { roughness: .85 }),
        railMat = mat('#8a939b', { metalness: .5, roughness: .45 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(rc, rc, H + .12, 16), poleMat);
      pole.position.y = (H + .12) / 2; pole.castShadow = pole.receiveShadow = true; g.add(pole);
      for (let i = 0; i < n; i++) {
        const a = dA * (i + .5), mid = (rc + R) / 2, tw = 2 * mid * Math.sin(Math.abs(dA) / 2);
        const t = new THREE.Mesh(new THREE.BoxGeometry(tw, stepH, R - rc), treadMat);
        t.position.set(Math.sin(a) * mid, stepH * (i + .5), Math.cos(a) * mid);
        t.rotation.y = a;                                       // 盒长轴（z）对准径向
        t.castShadow = t.receiveShadow = true; g.add(t);
      }
      const pts = [];                                           // 外缘螺旋扶手管
      for (let i = 0; i <= n; i++) {
        const a = dA * i, rr = R - .05;
        pts.push(new THREE.Vector3(Math.sin(a) * rr, stepH * i + .9, Math.cos(a) * rr));
      }
      {                                                         // 外缘扶手带高度线段碰撞：只拦翻出环带的人，不占内侧踏步通道（reach 取小值，避免堵死上行）
        const ct = Math.cos(g.rotation.y), st = Math.sin(g.rotation.y);
        const toW = p => [g.position.x + p.x * ct + p.z * st, g.position.z - p.x * st + p.z * ct];
        for (let i = 1; i < pts.length; i++) {
          const a0 = toW(pts[i - 1]), a1 = toW(pts[i]);
          addBarrier(a0[0], a0[1], a1[0], a1[1], pts[i - 1].y - .9, pts[i].y, .1);
        }
        for (let i = 1; i <= n; i++) {                          // 底部实体碰撞：每级踢面一条径向线（y 区间 = 该踢面高度段，超出 .34 收缩）——不能从螺旋楼梯下方水平穿过；梯面上因单级升 ≤ 可跨步高 .35，逐级上下不受影响
          const a = dA * i, sa = Math.sin(a), ca = Math.cos(a), yi = stepH * i, yp = yi - stepH;
          const A0 = toW({ x: sa * rc, z: ca * rc }), A1 = toW({ x: sa * R, z: ca * R });
          addBarrier(A0[0], A0[1], A1[0], A1[1], yp, Math.min(yi, yp + .34), .25, true);
        }
      }
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(24, n * 4), .022, 8), railMat);
      tube.castShadow = true; g.add(tube);
      for (let i = 0; i < n; i += 4) {                          // 扶手立柱（每 4 级一根）
        const a = dA * i, rr = R - .05;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(.024, .024, .9, 8), railMat);
        post.position.set(Math.sin(a) * rr, stepH * i + .45, Math.cos(a) * rr);
        post.castShadow = true; g.add(post);
      }
      colliders.push([wx(s.x) - rc, wz(s.y) - rc, wx(s.x) + rc, wz(s.y) + rc]);  // 只挡中心柱：整圈外接方形会连踏步区一起挡住，漫游时无法走上楼梯
      archUp.add(g);
    }
    function buildSteps3D(s) {                                  // 台阶：逐级实心踏步块（漫游可逐级上下）
      const N = Math.max(1, Math.round(s.steps || 3)), W = s.w / 1000, L = s.len / 1000, H = Math.max(.03, (s.rise ?? 450) / 1000);
      const g = new THREE.Group();
      g.position.set(wx(s.x), 0, wz(s.y)); tagPick(g, 'stair', s.id);
      g.rotation.y = -s.dir * Math.PI / 180 + (s.flipX ? Math.PI : 0);   // 前后翻转 = 整段调头
      const stMat = mat('#cfc4af', { roughness: .92 }), noseMat = mat('#b8ab92', { roughness: .92 });
      const d = L / N;
      for (let i = 0; i < N; i++) {
        const h = (i + 1) * H / N;
        const blk = new THREE.Mesh(new THREE.BoxGeometry(d, h, W), stMat);
        blk.position.set(-L / 2 + (i + .5) * d, h / 2, 0);
        blk.castShadow = blk.receiveShadow = true; g.add(blk);
        const nose = new THREE.Mesh(new THREE.BoxGeometry(.03, .035, W), noseMat);   // 踏步前缘的压边条
        nose.position.set(-L / 2 + (i + 1) * d - .015, h - .018, 0);
        nose.castShadow = true; g.add(nose);
      }
      if (s.land) {                                            // 末端平台：宽 × 0.8 梯宽，全高落地
        const pl = W * .8;
        const plat = new THREE.Mesh(new THREE.BoxGeometry(pl, H, W), stMat);
        plat.position.set(L / 2 + pl / 2, H / 2, 0);
        plat.castShadow = plat.receiveShadow = true; g.add(plat);
      }
      archUp.add(g);
    }
    function buildRail3D(r) {                                   // 栏杆 / 玻璃隔断：立柱 + 扶手（直杆 / 玻璃栏板 / 通高隔断）
      const A = [wx(r.a[0]), wz(r.a[1])], B = [wx(r.b[0]), wz(r.b[1])];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L < .08) return;
      const isPart = r.style === 'part';
      const H = isPart ? Math.max(.6, Math.min(3, (r.h ?? 2400) / 1000)) : Math.max(.3, Math.min(1.8, (r.h ?? 1000) / 1000));
      const g = new THREE.Group();
      g.position.set((A[0] + B[0]) / 2, 0, (A[1] + B[1]) / 2);
      g.rotation.y = Math.atan2(-(B[1] - A[1]), B[0] - A[0]);
      tagPick(g, 'rail', r.id);
      if (r.style === 'drain') {                                // 排水沟：下沉槽体 + 两侧压边 + 不锈钢格栅
        const W = Math.max(.04, Math.min(.3, (r.w ?? 80) / 1000));
        const slot = new THREE.Mesh(new THREE.BoxGeometry(L, .03, W), mat('#3c3b37', { roughness: .95 }));
        slot.position.set(0, .015, 0); slot.receiveShadow = true; g.add(slot);
        const met = mat('#b8babb', { metalness: .7, roughness: .3 });
        [-1, 1].forEach(s => {
          const rim = new THREE.Mesh(new THREE.BoxGeometry(L, .02, .018), met);
          rim.position.set(0, .01, s * (W / 2)); g.add(rim);
        });
        const n = Math.max(2, Math.round(L / .12));
        for (let i = 1; i < n; i++) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(.012, .012, Math.max(.02, W - .01)), met);
          bar.position.set(-L / 2 + i * L / n, .028, 0); g.add(bar);
        }
        archUp.add(g); return;
      }
      if (isPart) {                                             // 玻璃隔断：上下边框 + 竖梃 + 通高玻璃
        const fMat = mat('#5d6166', { metalness: .5, roughness: .42 });
        [.03, H - .03].forEach(y => {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(L, .06, .09), fMat);
          bar.position.set(0, y, 0); bar.castShadow = true; g.add(bar);
        });
        const pn = Math.max(1, Math.round(L / 1.2));
        for (let i = 0; i <= pn; i++) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(.04, H, .06), fMat);
          post.position.set(-L / 2 + i * L / pn, H / 2, 0); post.castShadow = true; g.add(post);
        }
        const pane = new THREE.Mesh(new THREE.BoxGeometry(Math.max(.05, L - .05), Math.max(.1, H - .12), .012), glassMat);
        pane.position.set(0, H / 2, 0); pane.receiveShadow = true; g.add(pane);
        archUp.add(g); return;
      }
      addBarrier(A[0], A[1], B[0], B[1], 0, H, .2);               // 栏杆 / 玻璃隔断：带高度线段碰撞，漫游时拦人（排水沟可通行，前面已 return）
      const mMat = mat('#8b8172', { metalness: .45, roughness: .45 }), pMat = mat('#79705f', { metalness: .4, roughness: .5 });
      const n = Math.max(1, Math.round(L / 1.05));
      for (let i = 0; i <= n; i++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(.05, H, .05), pMat);
        post.position.set(-L / 2 + i * L / n, H / 2, 0);
        post.castShadow = true; g.add(post);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(L, .06, .09), mMat);
      top.position.set(0, H - .03, 0); top.castShadow = true; g.add(top);
      if (r.style === 'glass') {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(L - .08, Math.max(.2, H - .16), .014), glassMat);
        pane.position.set(0, (H - .16) / 2 + .04, 0); pane.receiveShadow = true; g.add(pane);
      } else {
        const mid = new THREE.Mesh(new THREE.BoxGeometry(L, .04, .04), mMat);
        mid.position.set(0, H * .52, 0); mid.castShadow = true; g.add(mid);
      }
      archUp.add(g);
    }
    function buildBeam3D(b) {                                   // 梁：沿两点的矩形截面体，底标高可调
      const A = [wx(b.a[0]), wz(b.a[1])], B = [wx(b.b[0]), wz(b.b[1])];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L < .08) return;
      const W = Math.max(.06, (b.w ?? 200) / 1000), H = Math.max(.08, (b.h ?? 300) / 1000), Y = Math.max(0, (b.y ?? 2400) / 1000);
      const m = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), wallMat);
      m.position.set((A[0] + B[0]) / 2, Y + H / 2, (A[1] + B[1]) / 2);
      m.rotation.y = Math.atan2(-(B[1] - A[1]), B[0] - A[0]);
      m.castShadow = m.receiveShadow = true; tagPick(m, 'beam', b.id);
      archUp.add(m);
    }
    function buildSlab3D(s) {                                   // 地板 / 层顶楼板 / 旧普通楼板：矩形厚板；well 不生成几何，只定义洞口
      if (s.well || stackSkipSlabs.has(s.id)) return;             // 整栋模式：被上层地板完全盖住的层顶板不生成，避免共面闪烁 / 双倍板厚
      const W = Math.max(.1, (s.w || 0) / 1000), D = Math.max(.1, (s.d || 0) / 1000);
      const T = Math.max(.04, (s.thick ?? 120) / 1000), Y = (s.z ?? 0) / 1000;
      const fa = !!s.farea, top = !!s.top;                       // 地板：层底实体楼面；楼板：层顶实体板，顶面与本层层高齐平（略低 5mm 防与天花共面闪烁）
      const plateY = top ? H : Y;                               // 层顶楼板按本层层高就位；整栋模式下 H 已切为该层高
      let geo;
      if (fa || top) {
        const mx0 = s.x - (s.w || 200) / 2, mx1 = s.x + (s.w || 200) / 2, my0 = s.y - (s.d || 200) / 2, my1 = s.y + (s.d || 200) / 2;
        const shape = new THREE.Shape();
        shape.moveTo(wx(mx0), wz(my0)); shape.lineTo(wx(mx1), wz(my0)); shape.lineTo(wx(mx1), wz(my1)); shape.lineTo(wx(mx0), wz(my1));
        const clip = [];                                         // 楼梯间 / 电梯井 / 板洞穿过板面的矩形自动开洞（地板与层顶楼板同样响应镂空）
        fpHoles().forEach(h => {
          const ix0 = Math.max(h[0], wx(mx0)), ix1 = Math.min(h[2], wx(mx1)), iy0 = Math.max(h[1], wz(my0)), iy1 = Math.min(h[3], wz(my1));
          if (ix1 > ix0 + .05 && iy1 > iy0 + .05) clip.push([ix0, iy0, ix1, iy1]);
        });
        shape.holes = clip.map(h => { const p = new THREE.Path(); p.moveTo(h[0], h[1]); p.lineTo(h[2], h[1]); p.lineTo(h[2], h[3]); p.lineTo(h[0], h[3]); return p; });
        geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false });
        geo.rotateX(Math.PI / 2);                                // (x,y,z)→(x,−z,y)：拉伸方向转为 −y（向下），平面 y 映射到世界 z
      } else {
        geo = new THREE.BoxGeometry(W, T, D);
      }
      const m = new THREE.Mesh(geo, fa || top ? mat('#e6e0d4', { roughness: .92 }) : mat('#d8d2c6', { roughness: .85 }));
      m.position.set(fa || top ? 0 : wx(s.x), fa || top ? plateY - .005 : Y + T / 2, fa || top ? 0 : wz(s.y));
      m.castShadow = m.receiveShadow = true; tagPick(m, 'slab', s.id);
      if (s.ceil) m.userData.ceilMesh = true;                    // 吊顶不属于楼板开关的管理范围
      else m.visible = opt.slabs !== false;                      // 楼板开关：关闭时隐藏地板 / 楼板（房间地面在 buildArch 里同步隐藏）
      archUp.add(m);
    }
    function buildParapet3D(p) {                                // 女儿墙：墙身 + 压顶
      const A = [wx(p.a[0]), wz(p.a[1])], B = [wx(p.b[0]), wz(p.b[1])];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < .08) return;
      const T = Math.max(.06, (p.t ?? 120) / 1000), H = Math.max(.2, (p.h ?? 900) / 1000), Y = Math.max(0, (p.z ?? 2800) / 1000);
      const rot = Math.atan2(-(B[1] - A[1]), B[0] - A[0]);
      const cx = (A[0] + B[0]) / 2, cz = (A[1] + B[1]) / 2;
      addBarrier(A[0], A[1], B[0], B[1], Y, Y + H + .05, Math.max(.12, T / 2 + .06));  // 女儿墙 / 围墙：带高度线段碰撞，站到其高度层时拦人
      const body = new THREE.Mesh(new THREE.BoxGeometry(L, H, T), mat(p.fence ? '#c8b49a' : '#ddd6c8', { roughness: .9 }));
      body.position.set(cx, Y + H / 2, cz); body.rotation.y = rot;
      body.castShadow = body.receiveShadow = true; archUp.add(body);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(L, p.fence ? .09 : .05, T + (p.fence ? .1 : .06)), mat('#c9c0ae', { roughness: .8 }));
      cap.position.set(cx, Y + H + (p.fence ? .045 : .025), cz); cap.rotation.y = rot; cap.castShadow = true; archUp.add(cap);
      if (p.fence) {                                        // 围墙：按约 2.4m 间距加方形立柱
        const n = Math.max(1, Math.round(L / 2.4)), pw = T + .12, ph = H + .22;
        for (let i = 0; i <= n; i++) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pw), mat('#bfa98c', { roughness: .9 }));
          const x = A[0] + (B[0] - A[0]) * i / n, z = A[1] + (B[1] - A[1]) * i / n;
          post.position.set(x, Y + ph / 2, z); post.rotation.y = rot; post.castShadow = true; archUp.add(post);
        }
      }
    }
    function buildCanopy3D(c) {                                 // 雨棚：沿基线向一侧挑出的板
      const A = [wx(c.a[0]), wz(c.a[1])], B = [wx(c.b[0]), wz(c.b[1])];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < .08) return;
      const dep = Math.max(.1, (c.depth ?? 800) / 1000), T = Math.max(.04, (c.thick ?? 100) / 1000), Y = Math.max(0, (c.z ?? 2400) / 1000);
      const side = c.side === -1 ? -1 : 1;
      const ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L;
      const m = new THREE.Mesh(new THREE.BoxGeometry(L, T, dep), mat('#b9c0b8', { roughness: .8 }));
      m.position.set((A[0] + B[0]) / 2 - uz * side * dep / 2, Y + T / 2, (A[1] + B[1]) / 2 + ux * side * dep / 2);
      m.rotation.y = Math.atan2(-uz, ux);
      m.castShadow = m.receiveShadow = true; tagPick(m, 'canopy', c.id); archUp.add(m);
    }
    function buildBalcony3D(b) {                                // 阳台：挑板 + 选中边的玻璃 / 直杆 / 实体栏板
      const W = Math.max(.3, (b.w || 0) / 1000), D = Math.max(.3, (b.d || 0) / 1000);
      const T = Math.max(.06, (b.thick ?? 120) / 1000), Y = (b.z ?? 0) / 1000, RH = Math.max(.2, (b.rh ?? 900) / 1000);
      const g = new THREE.Group();
      g.position.set(wx(b.x), 0, wz(b.y)); tagPick(g, 'balcony', b.id);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), mat('#d8d2c6', { roughness: .85 }));
      slab.position.y = Y + T / 2; slab.castShadow = slab.receiveShadow = true; g.add(slab);
      const st = b.style || 'glass', sd = b.sides || ['l', 't', 'r', 'b'], base = Y + T;
      const postMat = mat('#8b8172', { metalness: .45, roughness: .45 });
      const addSide = (len, x, z, rot) => {
        {                                                       // 阳台护栏带高度线段碰撞：拦人防坠落（阳台悬空，必须挡）
          const cr = Math.cos(rot), sr = Math.sin(rot);
          const p = (lx, lz) => [g.position.x + x + lx * cr + lz * sr, g.position.z + z - lx * sr + lz * cr];
          const a0 = p(-len / 2, 0), a1 = p(len / 2, 0);
          addBarrier(a0[0], a0[1], a1[0], a1[1], base, base + RH + (b.glaze ? 1.4 : 0), .14);
        }
        const gg = new THREE.Group(); gg.position.set(x, 0, z); gg.rotation.y = rot;
        if (st === 'solid') {
          const wall = new THREE.Mesh(new THREE.BoxGeometry(len, RH, .1), mat('#ddd6c8', { roughness: .9 }));
          wall.position.y = base + RH / 2; wall.castShadow = wall.receiveShadow = true; gg.add(wall);
          const cap = new THREE.Mesh(new THREE.BoxGeometry(len + .04, .05, .14), mat('#c9c0ae', { roughness: .8 }));
          cap.position.y = base + RH + .025; cap.castShadow = true; gg.add(cap);
        } else {
          const n = Math.max(1, Math.round(len / 1.05));
          for (let i = 0; i <= n; i++) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(.05, RH, .05), postMat);
            post.position.set(-len / 2 + i * len / n, base + RH / 2, 0); post.castShadow = true; gg.add(post);
          }
          const top = new THREE.Mesh(new THREE.BoxGeometry(len, .06, .09), postMat);
          top.position.y = base + RH - .03; top.castShadow = true; gg.add(top);
          if (st === 'bar') {
            const mid = new THREE.Mesh(new THREE.BoxGeometry(len, .04, .04), postMat);
            mid.position.y = base + RH * .52; mid.castShadow = true; gg.add(mid);
          } else {
            const pane = new THREE.Mesh(new THREE.BoxGeometry(len - .08, Math.max(.2, RH - .16), .014), glassMat);
            pane.position.y = base + (RH - .16) / 2 + .04; pane.receiveShadow = true; gg.add(pane);
          }
        }
        if (b.glaze) {                                       // 封窗：栏板上方做落地玻璃 + 竖梃 + 上下横梁
          const GH = Math.max(.6, Math.min((b.gh ?? 1400) / 1000, Math.max(.6, 3.1 - RH)));
          const y0 = base + RH, n = Math.max(1, Math.round(len / 1.2));
          for (let i = 0; i <= n; i++) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(.05, GH, .07), frameMat);
            post.position.set(-len / 2 + i * len / n, y0 + GH / 2, 0); post.castShadow = true; gg.add(post);
          }
          [y0 + .03, y0 + GH - .03].forEach(y => {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(len, .06, .09), frameMat);
            bar.position.y = y; bar.castShadow = true; gg.add(bar);
          });
          const pane = new THREE.Mesh(new THREE.BoxGeometry(len - .08, Math.max(.2, GH - .1), .016), glassMat);
          pane.position.y = y0 + GH / 2; pane.receiveShadow = true; gg.add(pane);
        }
        g.add(gg);
      };
      if (sd.includes('t')) addSide(W, 0, -D / 2 + .05, 0);
      if (sd.includes('b')) addSide(W, 0, D / 2 - .05, 0);
      if (sd.includes('l')) addSide(D, -W / 2 + .05, 0, Math.PI / 2);
      if (sd.includes('r')) addSide(D, W / 2 - .05, 0, Math.PI / 2);
      archUp.add(g);
    }
    function buildPlanter3D(p) {                                // 花坛 / 种植池：四周池壁 + 种植土
      const W = Math.max(.2, (p.w || 0) / 1000), D = Math.max(.2, (p.d || 0) / 1000);
      const T = Math.min(Math.max(.04, (p.t ?? 100) / 1000), Math.min(W, D) / 2 - .02), H = Math.max(.1, (p.h ?? 450) / 1000), Y = (p.z ?? 0) / 1000;
      const g = new THREE.Group(); g.position.set(wx(p.x), 0, wz(p.y)); tagPick(g, 'planter', p.id);
      if (p.well) {                                             // 采光井：四周井壁 + 顶部压边 + 采光玻璃
        const Hw = Math.max(.6, (p.h ?? 2800) / 1000), wm = mat('#ddd6c8', { roughness: .9 }), rm = mat('#c9c0ae', { roughness: .8 });
        const put = (w, h, d, x, z, m) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
          b.position.set(x, Y + h / 2, z); b.castShadow = b.receiveShadow = true; g.add(b);
        };
        put(W, Hw, T, 0, -D / 2 + T / 2, wm);
        put(W, Hw, T, 0, D / 2 - T / 2, wm);
        put(T, Hw, Math.max(.01, D - T * 2), -W / 2 + T / 2, 0, wm);
        put(T, Hw, Math.max(.01, D - T * 2), W / 2 - T / 2, 0, wm);
        const glass = new THREE.Mesh(new THREE.BoxGeometry(Math.max(.02, W - .02), .012, Math.max(.02, D - .02)), glassMat);
        glass.position.y = Y + Hw - .02; glass.receiveShadow = true; g.add(glass);
        [[W + .04, .05, .07, 0, -D / 2], [W + .04, .05, .07, 0, D / 2], [.07, .05, D + .04, -W / 2, 0], [.07, .05, D + .04, W / 2, 0]]
          .forEach(([w, h, d, x, z]) => put(w, h, d, x, z, rm));
        colliders.push([wx(p.x) - W / 2, wz(p.y) - D / 2, wx(p.x) + W / 2, wz(p.y) + D / 2, Y, Y + Hw]);
        archUp.add(g); return;
      }
      const wallMat3 = mat('#cfc6b4', { roughness: .95 }), soilMat = mat('#5c4a34', { roughness: 1 });
      const add = (w, h, d, x, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat3);
        m.position.set(x, Y + h / 2, z); m.castShadow = m.receiveShadow = true; g.add(m);
      };
      add(W, H, T, 0, -D / 2 + T / 2);
      add(W, H, T, 0, D / 2 - T / 2);
      add(T, H, Math.max(.01, D - T * 2), -W / 2 + T / 2, 0);
      add(T, H, Math.max(.01, D - T * 2), W / 2 - T / 2, 0);
      const soil = new THREE.Mesh(new THREE.BoxGeometry(Math.max(.01, W - T * 2), .05, Math.max(.01, D - T * 2)), soilMat);
      soil.position.y = Y + H - .07; soil.receiveShadow = true; g.add(soil);
      if (p.bench) {                                           // 外围坐凳：沿两条长边各一条坐面（宽 350、高比池口低 50）
        const bw = .35, bh = Math.max(.35, H - .05);
        const bm = mat('#e2dccd', { roughness: .85 });
        [-1, 1].forEach(sd => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(W + bw * 2, bh, bw), bm);
          b.position.set(0, Y + bh / 2, sd * (D / 2 + bw / 2));
          b.castShadow = b.receiveShadow = true; g.add(b);
        });
      }
      archUp.add(g);
      colliders.push([wx(p.x) - W / 2, wz(p.y) - D / 2, wx(p.x) + W / 2, wz(p.y) + D / 2, Y, Y + (p.bench ? Math.max(H, .35) : H)]);
    }
    function buildFlue3D(f) {                                   // 烟道 / 风道：方管体 + 顶部压边
      const W = Math.max(.1, (f.w ?? 300) / 1000), D = Math.max(.1, (f.d ?? 300) / 1000);
      const H = Math.max(.5, (f.h ?? 2800) / 1000), Y = (f.z ?? 0) / 1000;
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), mat('#c3bdb1', { roughness: .92 }));
      body.position.set(wx(f.x), Y + H / 2, wz(f.y));
      body.castShadow = body.receiveShadow = true; tagPick(body, 'flue', f.id); archUp.add(body);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(W + .04, .04, D + .04), mat('#a9a294', { roughness: .85 }));
      cap.position.set(wx(f.x), Y + H + .02, wz(f.y)); cap.castShadow = true; tagPick(cap, 'flue', f.id); archUp.add(cap);
      colliders.push([wx(f.x) - W / 2, wz(f.y) - D / 2, wx(f.x) + W / 2, wz(f.y) + D / 2, Y, Y + H]);
    }
    function buildLamp3D(l) {                                   // 灯具 / 灯开关：灯体 + 夜景点光源（点光源挂 lampG，applyLight 统一按夜景与开关状态点亮）
      const X = wx(l.x), Z = wz(l.y), Y = ['floorSocket', 'deskSocket', 'floorSwitch'].includes(l.type) ? Math.max(0, (l.z ?? (l.type === 'deskSocket' ? 750 : 0)) / 1000) : Math.max(.3, (l.z ?? 1500) / 1000);
      const glow = PASSIVE_LAMP_TYPES.includes(l.type) ? null : oneMat(new THREE.MeshStandardMaterial({ color: '#fff6df', emissive: '#ffd9a0', emissiveIntensity: .3 }));
      if (glow) { glow.userData.lampRef = l; lampGlowMats.push(glow); }   // 发光材质记录归属的灯对象：开关状态变 → emissive 跟着变；插座不发光
      const headMat = (color, extra = {}) => {                   // 灯头 / 灯罩：白天也自发光，强度低于灯泡，随开关状态变化
        const m = oneMat(new THREE.MeshStandardMaterial({ color, roughness: .8, emissive: '#ffd9a0', emissiveIntensity: .3, ...extra }));
        m.userData.lampRef = l; m.userData.glowFactor = .45; lampGlowMats.push(m); return m;
      };
      if (WALL_LAMP_TYPES.includes(l.type)) {                   // 壁灯 / 壁装灯管 / 壁装灯泡：贴墙面朝外
        const q = wallLampPos(l), Nx = q ? q.n[0] : 0, Nz = q ? q.n[1] : 1;
        const g = new THREE.Group(); g.position.set(X, 0, Z);
        g.rotation.y = Math.atan2(Nx, Nz);                      // 局部 +Z 朝墙面外侧（-Z 贴墙）
        const mount = (w, h) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, .02), mat('#5a544b', { roughness: .7 })); m.position.set(0, Y, .01); g.add(m); return m; };
        if (l.type === 'wall') {                                // 壁灯：底座 + 弯臂 + 半球罩 + 灯泡
          mount(.09, .16);
          const arm = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, .12, 8), mat('#4d4a45', { roughness: .5, metalness: .4 }));
          arm.rotation.x = Math.PI / 2; arm.position.set(0, Y, .07); g.add(arm);
          const shade = new THREE.Mesh(new THREE.SphereGeometry(.095, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), headMat('#e7ddc9', { roughness: .55, side: THREE.DoubleSide }));
          shade.rotation.x = Math.PI / 2; shade.position.set(0, Y, .13); shade.castShadow = true; g.add(shade);
          const b2 = new THREE.Mesh(new THREE.SphereGeometry(.055, 14, 10), glow); b2.position.set(0, Y - .01, .1); g.add(b2);
        } else if (l.type === 'tube') {                         // 壁装灯管：两个抱箍 + 沿墙 600 发光灯管
          [-.3, .3].forEach(x => { const c = new THREE.Mesh(new THREE.TorusGeometry(.035, .008, 8, 16), mat('#8d949b', { metalness: .6, roughness: .4 })); c.position.set(x, Y, .04); g.add(c); });
          const tube = new THREE.Mesh(new THREE.CylinderGeometry(.024, .024, .6, 14), glow);
          tube.rotation.z = Math.PI / 2; tube.position.set(0, Y, .04); g.add(tube);
        } else if (l.type === 'bulb') {                         // 壁装灯泡：灯座 + 玻璃泡
          mount(.05, .05);
          const sock = new THREE.Mesh(new THREE.CylinderGeometry(.022, .026, .05, 10), mat('#c9a24b', { metalness: .7, roughness: .35 }));
          sock.rotation.x = Math.PI / 2; sock.position.set(0, Y, .045); g.add(sock);
          const b2 = new THREE.Mesh(new THREE.SphereGeometry(.06, 16, 12), glow); b2.position.set(0, Y, .1); g.add(b2);
        } else if (l.type === 'socket') {                       // 插座：统一标准 86 面板，型号决定孔位组合
          const stl = l.style || 'dual';
          const W = .086;                                       // 全部型号统一标准 86 面板（86×86mm）
          const base = new THREE.Mesh(new THREE.BoxGeometry(W, .086, .008), mat('#8d8069', { roughness: .8 }));
          base.position.set(0, Y, .004); g.add(base);
          const plate = new THREE.Mesh(new THREE.BoxGeometry(W, .086, .008), panelMat(l.panelMat));
          plate.position.set(0, Y, .012); plate.castShadow = true; g.add(plate);
          const slot = (w, h, x, y, c) => {                     // 扁插孔：中间接地孔与两侧火 / 零线孔都画竖槽
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, .003), mat(c || '#3a3630', { roughness: .9 }));
            m.position.set(x, Y + y, .017); g.add(m);
          };
          const twoPins = sx => { slot(.006, .012, sx - .016, .019); slot(.006, .012, sx + .016, .019); };
          const threePins = (sx, big) => {
            slot(big ? .008 : .006, big ? .015 : .012, sx, -.002, big ? '#b5653a' : '#3a3630');
            slot(.006, .012, sx - .018, -.024); slot(.006, .012, sx + .018, -.024);
          };
          const addBox = (w, h, x, y, c, dz = .003) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dz), typeof c === 'string' ? mat(c, { roughness: .7 }) : c); m.position.set(x, Y + y, .017); g.add(m); return m; };
          if (stl === 'dual') { twoPins(0); threePins(0); }
          else if (['dualSwitch', 'dualUsb', 'usbC', 'night', 'rcd', 'smart'].includes(stl)) { twoPins(-.018); threePins(-.018); }   // 孔位偏左，右侧留给附加模块
          else if (stl === 'quad') { twoPins(-.019); threePins(-.019); twoPins(.019); threePins(.019); }
          else if (stl === 'two') twoPins(0);
          else if (stl === 'two2') { twoPins(-.019); twoPins(.019); }
          else if (stl === 'three') threePins(0);
          else if (stl === 'three16') threePins(0, true);       // 16A：加大接地孔 + 橙色标记
          else if (stl === 'weather') { twoPins(0); threePins(0); }
          else if (stl === 'industrial') {
            const ring = new THREE.Mesh(new THREE.CylinderGeometry(.028, .028, .004, 24), mat('#4a4238', { roughness: .6 }));
            ring.rotation.x = Math.PI / 2; ring.position.set(0, Y, .017); g.add(ring);
            threePins(0, true);
          }
          if (stl === 'dualSwitch') addBox(.022, .046, .028, 0, '#f5f0e6', .01);                        // 带开关：右侧翘板
          if (stl === 'dualUsb') { addBox(.014, .007, .02, .004, '#3a3630'); addBox(.014, .007, .034, .004, '#3a3630'); }
          if (stl === 'usbC') { addBox(.014, .007, .02, .004, '#3a3630'); addBox(.018, .006, .033, .004, '#9aa2a8'); }
          if (stl === 'night') {
            const led = new THREE.Mesh(new THREE.SphereGeometry(.008, 12, 8), oneMat(new THREE.MeshStandardMaterial({ color: '#ffe6a0', emissive: '#ffd9a0', emissiveIntensity: 1.2 })));
            led.position.set(.028, Y + .006, .02); g.add(led);
          }
          if (stl === 'rcd') { addBox(.014, .012, .022, .006, '#c9c2b4'); addBox(.014, .012, .036, .006, '#b5653a'); }
          if (stl === 'smart') {
            addBox(.034, .014, .026, .004, '#3a3630');
            const led = new THREE.Mesh(new THREE.SphereGeometry(.004, 10, 8), oneMat(new THREE.MeshStandardMaterial({ color: '#5bc0eb', emissive: '#3a9fd0', emissiveIntensity: 1.2 })));
            led.position.set(.036, Y + .004, .021); g.add(led);
          }
          if (stl === 'weather') {                               // 防水翻盖：半透明盖板
            const cover = new THREE.Mesh(new THREE.BoxGeometry(.094, .094, .003), mat('#cfe6ef', { roughness: .25, transparent: true, opacity: .35 }));
            cover.position.set(0, Y, .023); g.add(cover);
          }
        } else if (l.type === 'network') {                      // 网络信息插座：86 面板 + 单 / 双 RJ45 金属口
          const base = new THREE.Mesh(new THREE.BoxGeometry(.086, .086, .008), mat('#8d8069', { roughness: .8 }));
          base.position.set(0, Y, .004); g.add(base);
          const plate = new THREE.Mesh(new THREE.BoxGeometry(.086, .086, .008), panelMat(l.panelMat));
          plate.position.set(0, Y, .012); plate.castShadow = true; g.add(plate);
          const addBox = (w, h, x, y, c, dz = .003) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dz), mat(c, { roughness: .7 })); m.position.set(x, Y + y, .02); g.add(m); return m; };
          const rj = x => {
            const shell = new THREE.Mesh(new THREE.BoxGeometry(.026, .02, .004), mat('#c9cdd2', { metalness: .7, roughness: .35 }));
            shell.position.set(x, Y, .017); g.add(shell);
            addBox(.02, .014, x, 0, '#2b2a28', .002);
            addBox(.008, .004, x, .006, '#e0d4a8', .002);
          };
          const coax = x => { const m = new THREE.Mesh(new THREE.CylinderGeometry(.011, .011, .004, 16), mat('#c9a24b', { metalness: .7, roughness: .35 })); m.rotation.x = Math.PI / 2; m.position.set(x, Y, .018); g.add(m); addBox(.006, .006, x, 0, '#2b2a28', .002); };
          const phone = x => addBox(.024, .012, x, 0, '#2b2a28');
          const usb = x => addBox(.02, .008, x, 0, '#3a3630');
          const hdmi = x => addBox(.032, .012, x, 0, '#3a3630');
          const fiber = x => { addBox(.008, .012, x - .007, 0, '#2f6f8f'); addBox(.008, .012, x + .007, 0, '#2f6f8f'); };
          const stl = l.style || 'rj45';
          ({
            rj45: () => rj(0), rj45x2: () => { rj(-.021); rj(.021); }, tv: () => coax(0), phone: () => phone(0),
            netTv: () => { rj(-.021); coax(.021); }, netPhone: () => { rj(-.021); phone(.021); }, netUsb: () => { rj(-.021); usb(.021); },
            hdmi: () => hdmi(0), fiber: () => fiber(0)
          }[stl] || (() => rj(0)))();
        } else if (l.type === 'trackSocket') {                  // 轨道插座：墙面长轨 + 2 / 3 个可取放模块
          const n = (l.style || 'track2') === 'track3' ? 3 : 2, len = n === 3 ? .9 : .6;
          const rail = new THREE.Mesh(new THREE.BoxGeometry(len, .03, .012), mat('#8d949b', { metalness: .6, roughness: .4 }));
          rail.position.set(0, Y, .012); rail.castShadow = true; g.add(rail);
          for (let i = 0; i < n; i++) {
            const sx = -len / 2 + (i + .5) * len / n;
            const mod = new THREE.Mesh(new THREE.CylinderGeometry(.055, .055, .03, 24), panelMat(l.panelMat));  // 圆形模块，正面朝外
            mod.rotation.x = Math.PI / 2;
            mod.position.set(sx, Y, .03); mod.castShadow = true; g.add(mod);
            [-.016, .016].forEach(dx => { const hole = new THREE.Mesh(new THREE.BoxGeometry(.006, .012, .002), mat('#3a3630', { roughness: .9 })); hole.position.set(sx + dx, Y, .047); g.add(hole); });
          }
        } else if (l.type === 'wallSwitch') {                   // 墙面开关：86 面板 + 按型号生成 1~4 联翘板（下方小点表示双控 / 多控）
          const [gangs, ways] = SWITCH_LAYOUT[l.style || 's1w1'] || SWITCH_LAYOUT.s1w1;
          const base = new THREE.Mesh(new THREE.BoxGeometry(.086, .086, .008), mat('#8d8069', { roughness: .8 }));
          base.position.set(0, Y, .004); g.add(base);
          const plate = new THREE.Mesh(new THREE.BoxGeometry(.086, .086, .008), panelMat(l.panelMat));
          plate.position.set(0, Y, .012); plate.castShadow = true; g.add(plate);
          const rw = gangs === 1 ? .048 : gangs === 2 ? .03 : gangs === 3 ? .021 : .016, gap = rw + .008;
          for (let i = 0; i < gangs; i++) {
            const sx = -((gangs - 1) * gap) / 2 + i * gap;
            const rocker = new THREE.Mesh(new THREE.BoxGeometry(rw, .055, .01), (l.panelMat || 'plastic') === 'plastic' ? mat('#f5f0e6', { roughness: .5 }) : panelMat(l.panelMat));
            rocker.position.set(sx, Y - .006, .02); g.add(rocker);
            if (gangs > 1) tagPick(rocker, 'lamp', l.id), rocker.userData.gang = i;   // 多联：每个翘板单独拾取，点哪联切哪联
            const dotMat = glow.clone(); dotMat.userData = { ...glow.userData, gangRef: { sw: l, gang: i } }; lampGlowMats.push(dotMat);
            const dot = new THREE.Mesh(new THREE.SphereGeometry(.006, 10, 8), dotMat); dot.position.set(sx, Y + .03, .017); g.add(dot);
            const marks = ways === 1 ? 0 : ways === 2 ? 1 : 2;      // 双控 1 点，多控 2 点
            for (let j = 0; j < marks; j++) {
              const mk = new THREE.Mesh(new THREE.BoxGeometry(.004, .004, .002), mat('#b5653a', { roughness: .8 }));
              mk.position.set(sx + (j - (marks - 1) / 2) * .009, Y - .036, .019); g.add(mk);
            }
          }
        }
        tagPick(g, 'lamp', l.id); archUp.add(g);
        if (isLightType(l.type) && lampG.children.filter(o => o.isPointLight).length < 28) {
          const pl = new THREE.PointLight(0xffd9a8, 0, Math.max(1.5, (l.r || 2200) / 1000), 1.5);
          pl.position.set(X + Nx * .18, Y, Z + Nz * .18); pl.userData.lampRef = l; lampG.add(pl);
        }
        return;
      }
      if (l.type === 'switch') {                                // 灯开关：小面板立在细杆上（1.1m），3D 点击切换周边的灯
        const g = new THREE.Group(); g.position.set(X, 0, Z);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(.015, .02, Y - .07, 8), mat('#5a544b', { roughness: .8 }));
        pole.position.y = (Y - .07) / 2 + .02; pole.castShadow = true; g.add(pole);
        const plate = new THREE.Mesh(new THREE.BoxGeometry(.1, .13, .02), panelMat(l.panelMat));
        plate.position.y = Y; plate.castShadow = true; g.add(plate);
        const btn = new THREE.Mesh(new THREE.CylinderGeometry(.024, .024, .026, 16), glow);
        btn.rotation.x = Math.PI / 2; btn.position.set(0, Y, .012); g.add(btn);
        tagPick(g, 'lamp', l.id);
        colliders.push([X - .08, Z - .08, X + .08, Z + .08]);
        archUp.add(g);
        return;
      }
      const g = new THREE.Group(); g.position.set(X, 0, Z);
      if (l.type === 'floorSocket' || l.type === 'deskSocket') {   // 地插 / 桌面插座：水平面面板 + 顶面插孔
        const fl = l.type === 'floorSocket';
        const W = fl ? .3 : .34, D = fl ? .3 : .14;
        const box = new THREE.Mesh(new THREE.BoxGeometry(W, .02, D), mat(fl ? '#8d8069' : '#5a544b', { roughness: .75 }));
        box.position.y = Y + .01; box.castShadow = box.receiveShadow = true; g.add(box);
        const top = new THREE.Mesh(new THREE.BoxGeometry(W - .03, .008, D - .03), panelMat(l.panelMat));
        top.position.y = Y + .026; g.add(top);
        const hole = (w, d, x, z, c) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, .002, d), mat(c || '#3a3630', { roughness: .9 })); m.position.set(x, Y + .031, z); g.add(m); };
        if (fl) {                                                // 五孔：上排两孔、下组三孔（接地孔在上，火 / 零线孔在下）
          [-.018, .018].forEach(x => hole(.006, .012, x, -.045));
          hole(.006, .012, 0, -.008, '#b5653a');
          [-.02, .02].forEach(x => hole(.006, .012, x, .035));
          if ((l.style || 'pop') === 'popUsb') hole(.02, .008, 0, .1, '#4a4238');
        } else if ((l.style || 'desk1') === 'desk2') {
          [-.085, .085].forEach(sx => {
            [-.016, .016].forEach(dx => hole(.006, .012, sx + dx, -.042));
            hole(.006, .012, sx, -.006, '#b5653a');
            [-.02, .02].forEach(dx => hole(.006, .012, sx + dx, .032));
          });
        } else {
          [-.071, -.039].forEach(x => hole(.006, .012, x, -.042));
          hole(.006, .012, -.055, -.006, '#b5653a');
          [-.075, -.035].forEach(x => hole(.006, .012, x, .032));
          hole(.02, .008, .08, 0, '#4a4238');
        }
        if (fl) colliders.push([X - W / 2, Z - D / 2, X + W / 2, Z + D / 2, Y, Y + .032]);   // 面板仅 3cm 高：贴地可踩踏，抬高安装后只在对应高度挡人
        tagPick(g, 'lamp', l.id); archUp.add(g);
        return;
      }
      if (l.type === 'floorSwitch') {                           // 地板开关：地面平嵌面板 + 按型号生成 1~4 联翘板（顶面朝上，点翘板切所控灯）
        const [gangs, ways] = SWITCH_LAYOUT[l.style || 's1w1'] || SWITCH_LAYOUT.s1w1;
        const W = .3, D = .3;
        const box = new THREE.Mesh(new THREE.BoxGeometry(W, .02, D), mat('#8d8069', { roughness: .75 }));
        box.position.y = Y + .01; box.castShadow = box.receiveShadow = true; g.add(box);
        const top = new THREE.Mesh(new THREE.BoxGeometry(W - .03, .008, D - .03), panelMat(l.panelMat));
        top.position.y = Y + .026; top.receiveShadow = true; g.add(top);
        const rw = gangs === 1 ? .13 : gangs === 2 ? .075 : gangs === 3 ? .052 : .04, gap = rw + .022;
        for (let i = 0; i < gangs; i++) {
          const sx = -((gangs - 1) * gap) / 2 + i * gap;
          const rocker = new THREE.Mesh(new THREE.BoxGeometry(rw, .01, .075), (l.panelMat || 'plastic') === 'plastic' ? mat('#f5f0e6', { roughness: .5 }) : panelMat(l.panelMat));
          rocker.position.set(sx, Y + .035, -.02); rocker.castShadow = true; g.add(rocker);
          if (gangs > 1) tagPick(rocker, 'lamp', l.id), rocker.userData.gang = i;   // 多联：每个翘板单独拾取，点哪联切哪联
          const dotMat = glow.clone(); dotMat.userData = { ...glow.userData, gangRef: { sw: l, gang: i } }; lampGlowMats.push(dotMat);
          const dot = new THREE.Mesh(new THREE.CylinderGeometry(.007, .007, .004, 10), dotMat); dot.position.set(sx, Y + .032, .055); g.add(dot);   // 该联受控灯全亮时指示灯亮
          const marks = ways === 1 ? 0 : ways === 2 ? 1 : 2;        // 双控 1 点，多控 2 点
          for (let j = 0; j < marks; j++) {
            const mk = new THREE.Mesh(new THREE.BoxGeometry(.005, .002, .005), mat('#b5653a', { roughness: .8 }));
            mk.position.set(sx + (j - (marks - 1) / 2) * .011, Y + .031, .055); g.add(mk);
          }
        }
        colliders.push([X - W / 2, Z - D / 2, X + W / 2, Z + D / 2, Y, Y + .045]);   // 面板 4.5cm 高：贴地可踩踏，抬高安装后只在对应高度挡人
        tagPick(g, 'lamp', l.id); archUp.add(g);
        return;
      }
      const R = { chandelier: .19, ceil: .17, down: .065, spot: .07, floor: .16 }[l.type] || .15;
      if (l.type === 'chandelier') {                            // 吊杆：从灯具上方房间的天花挂到灯体（室外 / 无天花挑空回落 2.75m 默认）
        const rodTop = Math.max(Y + .1, (ceilAtPoint(l.x, l.y) || 2750) / 1000);
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, rodTop - Y, 8), mat('#4d4a45', { roughness: .5, metalness: .4 }));
        rod.position.y = Y + (rodTop - Y) / 2; g.add(rod);
      }
      if (l.type === 'floor') {                                 // 落地灯：底盘 + 灯杆，占位挡路
        const base = new THREE.Mesh(new THREE.CylinderGeometry(.14, .16, .03, 24), mat('#4d4a45', { roughness: .7 }));
        base.position.y = .015; base.castShadow = true; g.add(base);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, Math.max(.1, Y - .12), 10), mat('#4d4a45', { roughness: .6 }));
        pole.position.y = (Y - .12) / 2 + .04; pole.castShadow = true; g.add(pole);
        colliders.push([X - .18, Z - .18, X + .18, Z + .18, 0, Y + .1]);
      }
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(R * .55, R, l.type === 'down' ? .05 : .14, 24), headMat('#ddd3c0'));
      shade.position.y = Y + (l.type === 'floor' ? .06 : 0); shade.castShadow = true; g.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(Math.max(.03, R * .6), 16, 12), glow);
      bulb.position.y = Y - (l.type === 'floor' ? .02 : .08); g.add(bulb);
      tagPick(g, 'lamp', l.id);
      archUp.add(g);
      if (lampG.children.filter(o => o.isPointLight).length < 28) {   // 实时光源数量上限：太多会拖垮帧率，超出的灯具只发光不照明
        const pl = new THREE.PointLight(0xffd9a8, 0, Math.max(1.5, (l.r || 3000) / 1000), 1.5);
        pl.position.set(X, Y - .08, Z); pl.userData.lampRef = l; lampG.add(pl);
      }
    }
    function toggleLamp(id, gang) {                             // 点灯体 / 开关：切换亮灭；开关把控制的灯一起切；传 gang 则只切该联
      const l = (state.lamps || []).find(x => x.id === id); if (!l) return;
      if (PASSIVE_LAMP_TYPES.includes(l.type)) return;         // 插座 / 网络插座不控制灯，点击只在 3D 里选中
      if (isSwitchType(l.type)) {
        const ids = new Set([l.id]), queue = [l];                // 双控 / 多控：沿关联开关组收集全部被控灯（传递关联）
        while (queue.length) {
          const s = queue.shift();
          (s.links || []).forEach(id => {
            if (ids.has(id)) return;
            ids.add(id);
            const n = (state.lamps || []).find(x => x.id === id); if (n && isSwitchType(n.type)) queue.push(n);
          });
        }
        // gang != null 时只取组内每个开关的第 gang 联；未分联的开关回退到整开关目标（兼容旧方案）
        const near = [...new Map([...ids].flatMap(id => {
          const s = (state.lamps || []).find(x => x.id === id);
          return s && isSwitchType(s.type) ? switchTargets(s, gang) : [];
        }).map(x => [x.id, x])).values()];
        const anyOff = near.some(x => x.on === false);
        near.forEach(x => x.on = anyOff);                       // 有灭的就全打开，否则全部关掉
        toast(near.length ? tr(`开关：已${anyOff ? '打开' : '关闭'} ${near.length} 盏灯`, `Switch: ${near.length} lamp(s) ${anyOff ? 'on' : 'off'}`)
          : tr('开关：没有控制任何灯', 'Switch: no lamps controlled'));
      } else {
        l.on = l.on === false;
        toast(tr(l.on ? '灯已打开' : '灯已关闭', l.on ? 'Lamp on' : 'Lamp off'));
      }
      applyLight(); markDirty(); renderPillars();
    }
    function toggleStreetLamp(id, sel = true) {                  // 3D 点击路灯 / 太阳能路灯灯杆：切换亮灭（漫游 / 预览传 sel=false 只开关不选中）
      const e = (state.extras || []).find(x => x.id === id && (x.type === 'streetlamp' || x.type === 'solarlamp')); if (!e) return;
      const solar = e.type === 'solarlamp';
      if (solar && e.on === false && (e.battery ?? 0) <= 0) {     // 太阳能路灯没电时不允许手动开灯
        toast(tr('电量不足，无法开灯', 'Battery empty — cannot switch on')); return;
      }
      e.on = e.on === false;                                     // 未设置 on 视为开，第一次点击关闭
      applyLight(); markDirty();
      if (typeof renderExtras2 === 'function') renderExtras2();
      if (sel) window.select?.({ kind: 'extra', id: e.id });     // 设计态顺带选中，面板可继续改灯型 / 尺寸 / 开关；漫游 / 预览态不选中
      const nm = solar ? tr('太阳能路灯', 'Solar lamp') : tr('路灯', 'Street lamp');
      toast(tr(`${nm}已${e.on ? '打开' : '关闭'}`, `${nm} ${e.on ? 'on' : 'off'}`));
    }
    function autoLightStreetlamps() {                            // 切入夜景时把手动关掉的路灯重新打开（夜景中仍可手动再关）
      const off = (state.extras || []).filter(e =>
        (e.type === 'streetlamp' || e.type === 'solarlamp') && e.on === false &&
        (e.type !== 'solarlamp' || (e.battery ?? 0) > 0));       // 太阳能路灯没电不自动开
      if (!off.length) return 0;
      if (typeof mutate === 'function') mutate(() => off.forEach(e => e.on = true));   // 经典脚本的 mutate：进撤销栈，并同步重绘 2D / 3D
      else { off.forEach(e => e.on = true); markDirty(); }
      return off.length;
    }
    function updateSolarPanelUI() {                              // 只刷面板里的电量数字 / 进度条，不整块重绘，避免输入框失焦
      const sel = ui.sel, e = sel?.kind === 'extra' ? (state.extras || []).find(x => x.id === sel.id) : null;
      if (!e || e.type !== 'solarlamp') return;
      const bat = Math.max(0, Math.min(100, +e.battery || 0));
      const val = document.querySelector('#exBatteryVal'); if (val) val.textContent = `${Math.round(bat)}%`;
      const bar = document.querySelector('#exBatteryBar');
      if (bar) { bar.style.width = `${bat}%`; bar.style.background = bat < 20 ? '#e5484d' : bat < 50 ? '#e8b44a' : '#3cc46e'; }
      const chk = document.querySelector('#exOn'); if (chk) chk.checked = e.on !== false;
    }
    function updateSolarVisuals() {                              // 3D 红色指示灯闪烁 + 杆身电量条（每 500ms 一次，开销可忽略）
      if (!scene) return;
      const blink = (performance.now() % 1000) < 500;
      scene.traverse(o => {
        const ud = o.userData || {};
        if (ud.solarIndicator) {
          const e = (state.extras || []).find(x => x.id === ud.solarIndicator);
          const active = e && ((!opt.night && (e.battery ?? 0) < 100) || (e.battery ?? 0) < 20);
          if (o.material?.emissiveIntensity !== undefined) o.material.emissiveIntensity = active && blink ? 2.6 : .08;
          if (o.material?.color?.setHex) o.material.color.setHex(active && blink ? 0xff5a4a : 0x3b1210);
        }
        if (ud.solarBatteryBar) {
          const e = (state.extras || []).find(x => x.id === ud.solarBatteryBar); if (!e) return;
          const bat = Math.max(0, Math.min(100, +e.battery || 0)) / 100;
          const L = ud.barLeft ?? -.17, H = ud.barHalf ?? .17;   // 条的左端 / 半宽（旧数据无标记走默认值）
          o.scale.x = Math.max(.001, bat);
          o.position.x = L + H * bat;
          if (o.material?.color?.setHex) o.material.color.setHex(bat < .2 ? 0xe5484d : bat < .5 ? 0xe8b44a : 0x3cc46e);
        }
      });
    }
    function solarStep() {                                       // 白天充电 / 夜晚开灯耗电：只改当前楼层数据，不进撤销栈（每 500ms 调用）
      const lamps = (state.extras || []).filter(e => e.type === 'solarlamp');
      if (!lamps.length) return;
      const night = !!opt.night, dt = .5;
      let changed = false, wentEmpty = false;
      lamps.forEach(e => {
        const charge = Math.max(.1, +e.charge || 2.5), drain = Math.max(.1, +e.drain || 1.2);
        if (!night) {
          const nb = Math.min(100, (e.battery ?? 0) + charge * dt);
          if (Math.abs(nb - (e.battery ?? 0)) > .001) { e.battery = Math.round(nb * 10) / 10; changed = true; }
        } else if ((e.battery ?? 0) <= 0) {
          if (e.on !== false) { e.on = false; changed = true; wentEmpty = true; }
        } else if (e.on !== false) {
          const nb = Math.max(0, (e.battery ?? 0) - drain * dt);
          e.battery = Math.round(nb * 10) / 10; changed = true;
          if (e.battery <= 0) { e.on = false; changed = true; wentEmpty = true; }
        }
      });
      if (changed) {
        markDirty();
        if (inited) applyLight();
        if (typeof renderExtras2 === 'function') renderExtras2();
        updateSolarPanelUI();
        if (wentEmpty) toast(tr('太阳能路灯电量耗尽，已自动熄灭', 'Solar lamp battery empty — switched off'));
      }
      updateSolarVisuals();
    }
    setInterval(solarStep, 500);                                // 独立于 3D 主循环：2D 模式下电量与指示灯同样持续变化
    function updateLaneLightVisual(id) {                          // 车道灯双灯颜色：当前信号常亮，其余暗色
      if (!scene || !scene.traverse) return;
      const e = (state.extras || []).find(x => String(x.id) === String(id)); if (!e) return;
      const lit = { red: 0xe5484d, green: 0x3cc46e }, dim = { red: 0x3a1512, green: 0x143a20 };
      scene.traverse(o => {
        const ud = o.userData || {};
        if (ud.laneLamp && String(ud.laneLamp) === String(id) && o.material?.color?.setHex) {
          o.material.color.setHex((e.sig || 'red') === ud.lanePos ? lit[ud.lanePos] : dim[ud.lanePos]);
        }
      });
    }
    function cycleLaneLight(id, sel) {                            // 点击车道灯：红 ↔ 绿切换；sel=设计态顺带选中
      const e = (state.extras || []).find(x => String(x.id) === String(id) && x.type === 'facLaneLight'); if (!e) return;
      e.sig = (e.sig || 'red') === 'red' ? 'green' : 'red';
      updateLaneLightVisual(e.id); markDirty();
      if (typeof renderExtras2 === 'function') renderExtras2();
      if (sel) window.select?.({ kind: 'extra', id: e.id });
      toast(tr(`车道灯已切到${e.sig === 'green' ? '绿灯 · 通行' : '红灯 · 禁行'}`, `Lane light switched to ${e.sig === 'green' ? 'green · go' : 'red · stop'}`));
    }
    function toggleGateArm(id, sel) {                             // 点击道闸：闸杆抬起 ⇄ 落下；sel=设计态顺带选中
      const e = (state.extras || []).find(x => String(x.id) === String(id) && x.type === 'facBarrierGate'); if (!e) return;
      e.open = e.open !== true;                                    // 初始 false（落下）
      const g = gateArms.find(a => String(a.id) === String(id)); if (g) g.open = e.open;
      markDirty();
      if (typeof renderExtras2 === 'function') renderExtras2();
      if (sel) window.select?.({ kind: 'extra', id: e.id });
      toast(tr(`道闸已${e.open ? '抬起 · 放行' : '落下 · 禁行'}`, `Barrier ${e.open ? 'raised · go' : 'lowered · stop'}`));
    }
    /* —— 升降横移车库交互：每格载车板存 / 取车（上层板降到地面换车再升回，地面层直接换车） —— */
    function stackCar(cg, cw, dep, tag) {                          // 一格载车板上的简化轿车（车身 + 车顶 + 侧窗带 + 四轮），随载车板一起升降
      const g = new THREE.Group();
      const bw = Math.min(1.72, Math.max(.95, cw * .82)), bl = Math.min(4.45, Math.max(2.2, dep * .84)), bh = .56, ch = .44;
      const bodyM = mat('#aebdc9', { metalness: .35, roughness: .45 }), glassM = mat('#2e3a44', { metalness: .4, roughness: .3 }), tyreM = mat('#2a2d30', { roughness: .95 });
      const put = (geo, m, x, y2, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y2, z); o.castShadow = o.receiveShadow = true; o.userData.park = tag; g.add(o); return o; };
      put(new THREE.BoxGeometry(bw, bh, bl), bodyM, 0, .3 + bh / 2, 0);                                  // 车身
      put(new THREE.BoxGeometry(bw * .84, ch, bl * .44), bodyM, 0, .3 + bh + ch / 2 - .04, -bl * .02);   // 车顶
      put(new THREE.BoxGeometry(bw * .86, .22, bl * .3), glassM, 0, .3 + bh + .13, -bl * .02);           // 侧窗带
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(.29, .29, .18, 12), tyreM);
        w.rotation.z = Math.PI / 2; w.position.set(sx * (bw / 2), .29, sz * (bl / 2 - .72)); w.userData.park = tag; g.add(w);
      });
      g.position.y = .04; cg.add(g); return g;
    }
    function stackApply(op, k) {                                   // k 0~1：0→0.42 压到地面、0.42→0.62 地面停留换车、0.62→1 升回原位
      const c = op.c;
      const down = k < .42 ? 1 - Math.pow(1 - Math.min(1, k / .42), 2) : k < .62 ? 1 : 1 - Math.pow(Math.min(1, (k - .62) / .38), 2);
      c.g.position.y = c.baseY - c.drop * down;
      if (c.car) c.car.visible = c.target ? k >= .42 : k < .42;     // 存车：车在地面出现后随板升上去；取车：车随板落到地面后开走
    }
    function stackToggle(id, cell, sel) {                          // 点一格载车板：有车 → 取走，无车 → 存入
      const e = (state.extras || []).find(x => String(x.id) === String(id)); if (!e) return;
      if (!e.st || typeof e.st !== 'object') e.st = {};
      const on = !e.st[cell];
      if (on) e.st[cell] = true; else delete e.st[cell];
      const key = String(id) + '_' + cell, c = stackCells.get(key), [lvs, cs] = String(cell).split('_');
      if (c) {
        if (on && !c.car) c.car = stackCar(c.g, c.cw, c.dep, { kind: 'stack', id: e.id, cell });
        c.target = on;
        const i = stackOps.findIndex(o => o.key === key); if (i >= 0) stackOps.splice(i, 1);
        if (c.drop < .12) { if (c.car) { c.car.visible = on; c.g.position.y = c.baseY; } }        // 地面层没有可降空间，直接换车
        else { const op = { key, c, t: 0, dur: 1.9 }; stackApply(op, 0); stackOps.push(op); }     // 上层：板压到地面换车再升回
      }
      markDirty();
      if (typeof renderExtras2 === 'function') renderExtras2();    // 2D 该格车形同步
      if (sel) window.select?.({ kind: 'extra', id: e.id });
      toast(tr(`${lvs}F ${+cs + 1} 号车位${on ? '已存车' : '已取车'}`, `Level ${lvs} stall ${+cs + 1} ${on ? 'occupied' : 'cleared'}`));
    }
    function applyParkVisual(id) {                                 // 停车场配套：按状态刷新灯色 + 动画目标（升降柱 / 伸缩门 / 车位灯 / 充电桩）
      const e = (state.extras || []).find(x => String(x.id) === String(id)); if (!e) return;
      const lamp = parkLamps.get('sensor' + e.id) || parkLamps.get('charger' + e.id);
      if (lamp?.material?.color?.setHex) {
        if (e.type === 'facStallSensor') lamp.material.color.setHex(e.occ ? 0xe5484d : 0x3cc46e);
        else lamp.material.color.setHex(e.busy ? 0x3f8fe0 : 0x3cc46e);
      }
      const a = parkAnims.find(x => String(x.id) === String(id) && x.kind !== 'wt');   // 转运站动画由 wtVisuals.lids 统一按 on 刷，避免这里误置为 e.open
      if (a) a.open = e.type === 'facRisingBollard' ? e.up === true : e.open === true;
      const sv = sanVisuals.get(String(id));                    // 环卫配套：按 on / binOpen 刷灯色 / 开合动画 / 水流
      if (sv) {
        sv.lamps.forEach(l => { if (l.mesh?.material?.color?.setHex) l.mesh.material.color.setHex(e.on ? l.onHex : l.offHex); });
        if (sv.binAnims) {                                      // 分类垃圾桶：四个桶盖各按自己的 binOpen 开合
          const bins = sanBinStates(e);
          sv.binAnims.forEach((a, i) => { a.open = bins[i] === true; });
        }
        if (sv.cpAnims) {                                       // 垃圾收集点：各桶盖按自己的 cpOpen 开合
          const bins = cpBinStates(e, sv.cpAnims.length);
          sv.cpAnims.forEach((a, i) => { a.open = bins[i] === true; });
        }
        if (sv.portAnims) {                                     // 回收站：三个投放口各按自己的 ports 开合
          const ports = sanPortStates(e);
          sv.portAnims.forEach((a, i) => { a.open = ports[i] === true; });
        }
        (sv.doors || []).forEach(d => { if (d.a) d.a.open = e.on === true; });
        (sv.water || []).forEach(w => { if (w) w.visible = e.on === true; });
      }
      const wv = wtVisuals.get(String(id));                     // 垃圾转运站：按 on 刷状态灯 / 盖门动画 / 水雾 / 推杆运行
      if (wv) {
        wv.lamps.forEach(l => { if (l.mesh?.material?.color?.setHex) l.mesh.material.color.setHex(e.on ? l.onHex : l.offHex); });
        wv.lids.forEach(a2 => { a2.open = e.on === true; });
        (wv.mists || []).forEach(m2 => { if (m2) m2.visible = e.on === true; });
        (wv.runs || []).forEach(r2 => { r2.on = e.on === true; });
      }
      const ws = washVisuals.get(String(id));                   // 自动洗车机：状态灯空闲绿 / 洗车蓝；洗车流程由 carWashStep 时间轴驱动
      if (ws?.lamp?.material?.color) ws.lamp.material.color.setHex(e.busy === true ? 0x3f8fe0 : 0x3cc46e);
      doors.forEach(d => { if (d.sandoor != null && String(d.sandoor) === String(id)) d.open = e.doorOpen !== false; });   // 公厕 / 移动厕所门扇：按 doorOpen 单独开关，与 on 切灯互不干扰
      doors.forEach(d => { if (d.sancab != null && String(d.sancab) === String(id)) d.open = e.cabOpen === true; });       // 洗手台柜门：按 cabOpen 单独开合，与出水 / 停水互不干扰
      doors.forEach(d => { if (d.sanOn != null && String(d.sanOn) === String(id)) d.open = e.on === true; });           // 垃圾房 / 工具柜 / 回收站双扇门：按 on 开合（点门扇或属性面板勾选切 on，点房体不动作）
      if (e.type === 'sanRestRoom' && typeof applyLight === 'function') applyLight();   // 休息室灯：刷新真实点光源强度与灯泡自发光（白天 / 夜景都随 on 亮灭）
    }
    function togglePark(p, sel) {                                  // 点击升降柱 / 伸缩门 / 车位灯 / 充电桩 / 立体车库载车板：切状态 + 刷新 3D 动画 / 2D 符号
      if (!p) return;
      if (p.kind === 'stack') { stackToggle(p.id, p.cell, sel); return; }   // 立体车库：按「格」存 / 取车，逻辑独立
      const e = (state.extras || []).find(x => String(x.id) === String(p.id)); if (!e) return;
      let washBegan = false;                                          // 自动洗车机：本次点击是否新启动了流程
      if (p.kind === 'bollard') e.up = e.up !== true;
      else if (p.kind === 'gate') e.open = e.open !== true;
      else if (p.kind === 'sensor') e.occ = e.occ !== true;
      else if (p.kind === 'charger') e.busy = e.busy !== true;
      else if (p.kind === 'san') {
        if (e.type === 'sanSortBin' && p.part != null) {         // 分类垃圾桶：只切点中的那个桶，其余保持原状
          const bins = sanBinStates(e).slice();
          bins[p.part] = !bins[p.part];
          e.binOpen = bins;
        } else if (e.type === 'sanCollectPoint' && p.part != null) {  // 垃圾收集点：只切点中的那个桶盖，清运灯状态不变
          const sv = sanVisuals.get(String(e.id));
          const n = sv?.cpAnims?.length || Math.max(2, Math.round(M(e.w || 2400) / .7));
          const bins = cpBinStates(e, n).slice();
          bins[p.part] = !bins[p.part];
          e.cpOpen = bins;
        } else if (e.type === 'sanRecycleStation' && p.part != null) {  // 回收站：只切点中的那个投放口，其余保持原状
          const ports = sanPortStates(e).slice();
          ports[p.part] = !ports[p.part];
          e.ports = ports;
        } else e.on = e.on !== true;
      }
      else if (p.kind === 'sandoor') e.doorOpen = e.doorOpen === false;   // 公厕门扇：开↔关（默认开，首次点关闭）
      else if (p.kind === 'sancab') e.cabOpen = e.cabOpen !== true;       // 洗手台柜门：开↔关（默认关，首次点打开）
      else if (p.kind === 'sanSwitch') e.on = e.on !== true;            // 环卫休息室门边开关：开↔关灯（独立于房体点击）
      else if (p.kind === 'wt') e.on = e.on !== true;                   // 垃圾转运站：卷帘门 / 压缩机 / 箱盖 / 喷淋统一切 on
      else if (p.kind === 'wash') {                                     // 自动洗车机：空闲点击启动洗车流程，洗车中再点只提示
        if (e.busy === true) e.busy = true;
        else { e.busy = true; startWash(e.id, e.dur); washBegan = true; }
      }
      applyParkVisual(e.id); markDirty();
      if (typeof renderExtras2 === 'function') renderExtras2();    // 2D 俯视状态同步
      if (sel) window.select?.({ kind: 'extra', id: e.id });
      let zh, en;
      if (p.kind === 'san' || p.kind === 'sanSwitch') {
        if (e.type === 'sanSortBin' && p.part != null) {
          const CN = ['蓝', '红', '绿', '灰'], EN = ['blue', 'red', 'green', 'grey'], open = sanBinStates(e)[p.part] === true;
          zh = `分类垃圾桶：${CN[p.part]}桶盖已${open ? '打开' : '合上'}`;
          en = `Sorting bin: ${EN[p.part]} lid ${open ? 'opened' : 'closed'}`;
        } else if (e.type === 'sanCollectPoint' && p.part != null) {
          const open = Array.isArray(e.cpOpen) && e.cpOpen[p.part] === true;
          zh = `垃圾收集点：第 ${p.part + 1} 个桶盖已${open ? '打开' : '合上'}`;
          en = `Collection point: bin ${p.part + 1} lid ${open ? 'opened' : 'closed'}`;
        } else if (e.type === 'sanRecycleStation' && p.part != null) {
          const CN = ['蓝', '红', '绿'], EN = ['blue', 'red', 'green'], open = sanPortStates(e)[p.part] === true;
          zh = `回收站：${CN[p.part]}色投放口已${open ? '打开' : '合上'}`;
          en = `Recycling station: ${EN[p.part]} port ${open ? 'opened' : 'closed'}`;
        } else {
          const S = SAN_TOAST[e.type] || ['已切换', 'Toggled'];
          zh = e.on ? S[0] : S[1]; en = e.on ? S[2] : S[3];
        }
      } else if (p.kind === 'wt') {
        const S = WT_TOAST[e.type] || ['已开启', '已关闭', 'On', 'Off'];
        zh = e.on ? S[0] : S[1]; en = e.on ? S[2] : S[3];
      } else if (p.kind === 'wash') {
        zh = washBegan ? `自动洗车机：开始洗车 · 全程 ${e.dur || 14} 秒` : '自动洗车机：洗车进行中 · 请稍候';
        en = washBegan ? `Car wash: started · about ${e.dur || 14} s` : 'Car wash: in progress · please wait';
      } else if (p.kind === 'sandoor') {
        zh = e.doorOpen === false ? '门已关闭' : '门已打开'; en = e.doorOpen === false ? 'Door closed' : 'Door opened';
      } else if (p.kind === 'sancab') {
        zh = e.cabOpen === true ? '柜门已打开' : '柜门已关闭'; en = e.cabOpen === true ? 'Cabinet door opened' : 'Cabinet door closed';
      } else {
        zh = p.kind === 'bollard' ? (e.up ? '升降柱已升起 · 禁行' : '升降柱已落下 · 放行')
          : p.kind === 'gate' ? (e.open ? '伸缩门已收拢 · 放行' : '伸缩门已展开 · 关闭')
            : p.kind === 'sensor' ? (e.occ ? '车位指示灯：有车 · 红灯' : '车位指示灯：空位 · 绿灯')
              : (e.busy ? '充电桩：充电中 · 蓝灯' : '充电桩：空闲 · 绿灯');
        en = p.kind === 'bollard' ? (e.up ? 'Bollard raised · stop' : 'Bollard lowered · go')
          : p.kind === 'gate' ? (e.open ? 'Gate folded · open' : 'Gate unfolded · closed')
            : p.kind === 'sensor' ? (e.occ ? 'Stall sensor: occupied · red' : 'Stall sensor: free · green')
              : (e.busy ? 'Charger: charging · blue' : 'Charger: idle · green');
      }
      toast(tr(zh, en));
    }
    window.applyParkVisual = applyParkVisual;                      // 供经典脚本的属性面板开关回调调用
    const TRAFFIC_SEQ = ['red', 'green', 'yellow'];
    function updateTrafficLampVisual(id) {                       // 信号灯三灯颜色：当前信号常亮，其余暗色（每灯独立 MeshBasicMaterial，直接改色）
      if (!scene) return;
      const e = (state.extras || []).find(x => String(x.id) === String(id)); if (!e) return;
      const lit = { red: 0xe5484d, yellow: 0xf5c542, green: 0x3cc46e }, dim = { red: 0x3a1512, yellow: 0x3a3114, green: 0x143a20 };
      scene.traverse(o => {
        const ud = o.userData || {};
        if (ud.trafficLamp && String(ud.trafficLamp) === String(id) && o.material?.color?.setHex) {
          o.material.color.setHex(ud.trafficPos === (e.sig || 'red') ? lit[ud.trafficPos] : dim[ud.trafficPos]);
        }
      });
    }
    function cycleTrafficLight(id, sel) {                        // 点击信号灯：切到下一个信号（红 → 绿 → 黄 → 红）；sel = 设计态顺带选中
      const e = (state.extras || []).find(x => String(x.id) === String(id) && x.type === 'traflight'); if (!e) return;
      e.sig = TRAFFIC_SEQ[(TRAFFIC_SEQ.indexOf(e.sig || 'red') + 1) % TRAFFIC_SEQ.length];
      updateTrafficLampVisual(e.id); markDirty();
      if (typeof renderExtras2 === 'function') renderExtras2();  // 2D 俯视状态点同步
      if (sel) window.select?.({ kind: 'extra', id: e.id });
      const zh = TRAFFIC_SIGNS_ZH[e.sig] || e.sig;
      toast(tr(`信号灯已切换到${zh}`, `Signal switched to ${zh}`));
    }
    let beaconPhase = 0;
    function flashBeaconStep() {                                // 爆闪灯闪烁：切 3D 灯材质颜色（不重建、不入撤销栈）
      beaconPhase = 1 - beaconPhase;
      if (!scene || !scene.traverse) return;                    // scene 为同作用域的模块级变量
      scene.traverse(o => { if (o.userData && o.userData.flashBeacon && o.material && o.material.color) o.material.color.setHex(beaconPhase ? 0xffc233 : 0x4a3c14); });
    }
    let trafficClock = 0;
    function trafficStep() {                                     // 信号灯自动轮播：每 4s 切一相，只改当前数据不入撤销栈（每 500ms 调用）
      flashBeaconStep();                                         // 太阳能爆闪灯：双灯交替闪烁
      const tls = (state.extras || []).filter(e => e.type === 'traflight' && e.auto !== false);
      if (!tls.length) return;
      trafficClock += .5;
      if (trafficClock < 4) return;
      trafficClock = 0;
      tls.forEach(e => { e.sig = TRAFFIC_SEQ[(TRAFFIC_SEQ.indexOf(e.sig || 'red') + 1) % TRAFFIC_SEQ.length]; updateTrafficLampVisual(e.id); });
      markDirty();
      if (typeof renderExtras2 === 'function') renderExtras2();
    }
    setInterval(trafficStep, 500);
    function buildBox3D(kind, b) {                              // 强电箱 / 弱电箱：暗装箱体（嵌墙 + 门框饰边）+ 内部器件 + 可点击开合箱门
      const isP = kind === 'pbox';
      const W = Math.max(.2, (b.w || 0) / 1000), D = Math.max(.12, (b.d || 0) / 1000);
      const H = Math.max(.15, Math.min(1.2, (b.h ?? 320) / 1000)), Y = Math.max(0, (b.z ?? 1500) / 1000);
      const FR = b.front === -1 ? -1 : 1;
      const g = new THREE.Group();
      g.position.set(wx(b.x), 0, wz(b.y)); g.rotation.y = -(b.dir || 0) * Math.PI / 180;
      tagPick(g, kind, b.id);
      const shell = mat(isP ? '#ece5d8' : '#e3eef3', { roughness: .68, metalness: .12 });
      const inner = mat('#514c45', { roughness: .92 }), frame = mat('#a9a49a', { metalness: .55, roughness: .45 });
      const put = (w, h, d, x, y, z, m) => {
        const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
        o.position.set(x, Y + y, z); o.castShadow = o.receiveShadow = true; g.add(o); return o;
      };
      put(W, H, .035, 0, H / 2, -FR * (D / 2 - .018), inner);     // 内壁（深色背板）
      put(.035, H, D, -W / 2 + .018, H / 2, 0, shell);           // 两侧板
      put(.035, H, D, W / 2 - .018, H / 2, 0, shell);
      put(W, .035, D, 0, .018, 0, shell);                        // 底板 / 顶板
      put(W, .035, D, 0, H - .018, 0, shell);
      const rim = .018, rimD = .028, rz = FR * (D / 2 + .002);   // 门框饰边：盖住墙洞切口，箱门面与墙面齐平
      put(W + rim * 2, rim, rimD, 0, rim / 2, rz, frame);
      put(W + rim * 2, rim, rimD, 0, H - rim / 2, rz, frame);
      put(rim, H, rimD, -W / 2 - rim / 2, H / 2, rz, frame);
      put(rim, H, rimD, W / 2 + rim / 2, H / 2, rz, frame);
      const devs = isP ? devOrdered(b).map(k => [/^rcd/i.test(k) ? 'rcd' : 'mcb', k])
        : (b.devices || []).map(k => ['dev', k]);
      const poles = k => { const m = /(\d)p/i.exec(k || ''); return Math.max(1, Math.min(3, m ? +m[1] : 1)); };   // 占用模数：1P=1、2P / 漏电=2、3P=3
      const pp = devs.slice(0, 24).map(([, k]) => poles(k));      // 极数
      const pw = devs.slice(0, 24).map(([, k], i) => pp[i] === 2 && /^rcd/i.test(k) ? 4 : pp[i]), IW3 = W - .08;   // 占宽（模数）：漏保 2P 占 4 格
      const fitR3 = u => { let r = 1, x = 0; for (const p of pw) { const need = p * u + (x ? .002 : 0); if (x + need > IW3) { r++; x = 0; } x += p * u + .002; } return r; };
      let U3 = .018;                                     // 强电箱：DIN 模数 1P = 18mm；弱电箱：设备均分箱内宽度
      if (isP) for (U3 = .018; U3 >= .012; U3 -= .002) { if (fitR3(U3) * .09 <= H - .07) break; }
      else U3 = Math.max(.04, Math.min(.12, devs.length ? IW3 / devs.slice(0, 24).length - .006 : IW3));
      let rx = -W / 2 + .04;
      const r3 = fitR3(U3), ry = Y + (H - r3 * .07 - (r3 - 1) * .02) / 2;   // 器件在箱内上下居中
      devs.slice(0, 24).forEach(([key, k], i) => {
        const p = pp[i], bw = pw[i] * U3;
        if (rx + bw > W / 2 - .04) { rx = -W / 2 + .04; ry += .09; }
        if (ry > Y + H - .08) return;
        const x = rx + bw / 2, y = ry; rx += bw + .002;
        const zc = -FR * (D / 2 - .06), zf = zc + FR * .0225;       // 器件中心 / 朝箱门一侧的正面
        if (key === 'dev') {                              // 弱电箱设备：彩色设备盒 + 指示灯 / 天线 / 端口排，不画空开外观
          const color = k === 'wifi' ? '#e8eaee' : k === 'switch' ? '#5d9a72' : k === 'router' ? '#b9b3a8' : '#5f93b0';
          const o = new THREE.Mesh(new THREE.BoxGeometry(bw, .07, .045), mat(color, { roughness: .6 }));
          o.position.set(x, y, zc); o.castShadow = true; g.add(o);
          if (k === 'router' || k === 'wifi') {           // 天线两根
            [-.25, .25].forEach(f => {
              const ant = new THREE.Mesh(new THREE.CylinderGeometry(.002, .002, .05, 8), mat('#3a3630', { roughness: .7 }));
              ant.position.set(x + f * bw, y + .075, zc); g.add(ant);
            });
          } else {                                        // 光猫 / 交换机：正面端口排
            for (let t = 0; t < 4; t++) {
              const pt = new THREE.Mesh(new THREE.BoxGeometry(bw * .12, .014, .004), mat('#2f2c27', { roughness: .8 }));
              pt.position.set(x - bw * .3 + t * bw * .2, y + .022, zf + FR * .004); g.add(pt);
            }
          }
          const led = new THREE.Mesh(new THREE.BoxGeometry(.008, .008, .005), new THREE.MeshBasicMaterial({ color: '#7fe08e' }));
          led.position.set(x, y - .012, zf + FR * .004); g.add(led);
          return;
        }
        const isRcd = key === 'rcd', isLe4 = isRcd && p === 2;   // 漏保 2P 占 4 格：开关居左 2 格，测试按钮 / 漏电指示居右 2 格
        const hx = isLe4 ? x - bw * .25 : x;          // 开关部分（手柄 / 型号）中心
        const o = new THREE.Mesh(new THREE.BoxGeometry(bw, .07, .045), mat(isRcd ? '#f2ece0' : '#f4f2ee', { roughness: .6 }));
        o.position.set(x, y, zc); o.castShadow = true; g.add(o);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(bw - .012, .012, .006), mat('#6a655c', { roughness: .8 }));       // 顶部接线端子条
        bar.position.set(x, y + .026, zf + FR * .004); g.add(bar);
        {                                     // 接线端子：漏保 2P 上面 2 个在左半格 / 下面 4 个全宽分布；其余（含空开 2P）上下均匀，大小统一
          const even = Array.from({ length: p }, (_, t) => -bw / 2 + bw * (t + 1) / (p + 1));
          const topPos = isLe4 ? [-bw * .375, -bw * .125] : even, botPos = isLe4 ? [-bw * .375, -bw * .125, bw * .125, bw * .375] : even;
          topPos.forEach(tx => {
            const tm = new THREE.Mesh(new THREE.BoxGeometry(.011, .01, .004), mat('#5a554c', { roughness: .8 }));
            tm.position.set(x + tx, y + .026, zf + FR * .004); g.add(tm);
          });
          botPos.forEach(tx => {
            const tm = new THREE.Mesh(new THREE.BoxGeometry(.011, .01, .004), mat('#5a554c', { roughness: .8 }));
            tm.position.set(x + tx, y - .026, zf + FR * .004); g.add(tm);
          });
        }
        const brand = new THREE.Mesh(new THREE.BoxGeometry(.014, .01, .003), mat('#c23325', { roughness: .6 }));           // 红色品牌块
        brand.position.set(x - bw * .3, y + .016, zf + FR * .003); g.add(brand);
        const slot = new THREE.Mesh(new THREE.BoxGeometry(bw * (isLe4 ? .34 : isRcd ? .68 : .5), .022, .004), mat('#8a2a1e', { roughness: .8 }));        // 手柄槽座（漏保 2P 缩到左半格）
        slot.position.set(hx, y - .004, zf + FR * .002); g.add(slot);
        const tog = new THREE.Mesh(new THREE.BoxGeometry(bw * (isLe4 ? .3 : isRcd ? .6 : .44), .014, .008), mat('#d63a2a', { roughness: .5 }));         // 拨杆底块
        tog.position.set(hx, y - .007, zf + FR * .007); tog.castShadow = true; g.add(tog);
        const tog2 = new THREE.Mesh(new THREE.BoxGeometry(bw * (isLe4 ? .19 : isRcd ? .38 : .28), .01, .006), mat('#e85c4a', { roughness: .45 }));       // 拨杆顶块
        tog2.position.set(hx, y - .002, zf + FR * .012); tog2.castShadow = true; g.add(tog2);
        if (isRcd) {                                                // 漏电：大号橙色方形测试按钮 + 蓝色漏电指示块（漏保 2P 居右半格）
          const tb = new THREE.Mesh(new THREE.BoxGeometry(bw * (isLe4 ? .24 : .3), .016, .005), mat('#f0a13c', { roughness: .6 }));
          tb.position.set(x + bw * (isLe4 ? .25 : .24), y + .018, zf + FR * .004); g.add(tb);
          const ind = new THREE.Mesh(new THREE.BoxGeometry(bw * (isLe4 ? .2 : .24), .01, .004), mat('#5b9bd5', { roughness: .7 }));
          ind.position.set(x + bw * (isLe4 ? .25 : .24), y - .024, zf + FR * .004); g.add(ind);
        }
        const led = new THREE.Mesh(new THREE.BoxGeometry(.012, .012, .006), new THREE.MeshBasicMaterial({ color: key === 'rcd' ? '#ffd9a0' : '#bfe6cf' }));
        led.position.set(hx + bw * .3, y + .015, -FR * (D / 2 - .082)); g.add(led);
      });
      const hng = (b.hinge ?? 1) === -1 ? -1 : 1;   // 铰链侧：1 左（默认）-1 右，铰链组 / 门扇 / 把手随之镜像
      const hinge = new THREE.Group();
      hinge.position.set(-hng * (W / 2 - .015), 0, FR * (D / 2 + .006));
      const rad = Math.max(30, Math.min(170, b.ang ?? 120)) * Math.PI / 180;
      const edoor = { open: !!b.doorOpen, cur: b.doorOpen ? 1 : 0, a0: 0, a1: -hng * FR * rad, pivot: hinge, kind, id: b.id };
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(W - .03, H - .03, .018), mat(isP ? '#dcd5c7' : '#d7e8ef', { roughness: .55, metalness: .18 }));
      leaf.position.set(hng * (W - .03) / 2, Y + H / 2, 0); leaf.castShadow = true;
      leaf.userData.door = hinge.userData.door = edoor; hinge.add(leaf);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(.016, .09, .024), frame);
      handle.position.set(hng * (W - .085), Y + H / 2, FR * .018); handle.userData.door = edoor; hinge.add(handle);
      g.add(hinge); doors.push(edoor);
      archUp.add(g);
    }
    // 电梯呼叫面板纹理：顶部楼层显示屏（当前层高亮）+ 每层按钮 + 开门 / 关门按钮，返回 { texture, geoY, hit }
    // hit 为各按钮在面板局部的 y（米，自面板底起）及高度，供放置透明命中盒；纹理像素 y 向下、世界 y 向上
    function liftCallPanel(l, lit) {                              // lit：已登记并亮灯的目标楼层索引集合（可选）
      const floors = Array.isArray(l.floors) && l.floors.length ? l.floors : [l.stop ?? 0];
      const S = 96, pad = 8, dispH = 60, rowH = 40, ctrlH = 44;
      const Hpx = pad + dispH + 6 + floors.length * rowH + 6 + ctrlH + pad;
      const cv = document.createElement('canvas'); cv.width = S; cv.height = Hpx;
      const g = cv.getContext('2d');
      const rows = [];                                            // 按钮位置固定，命中盒只在构建时算一次
      {
        let y = pad + dispH + 6;
        for (let k = floors.length - 1; k >= 0; k--, y += rowH) rows.push({ act: 'floor', floor: k, cy: y + rowH / 2, cx: S / 2 });
        y += 6; const cy = y + ctrlH / 2;
        rows.push({ act: 'open', cy, cx: S / 2 - 20 }, { act: 'close', cy, cx: S / 2 + 20 });
      }
      const paint = (c, lights) => {                              // 整张重绘：显示屏楼层 + 按钮灯光（目标层点亮 / 当前层青圈）
        const cur = Math.max(0, Math.min(floors.length - 1, Math.round(c ?? 0)));
        g.fillStyle = '#1c2128'; g.fillRect(0, 0, S, Hpx);
        g.fillStyle = '#2b323c'; g.fillRect(2, 2, S - 4, Hpx - 4);
        const dy = pad;                                           // 显示屏：深色底 + 当前楼层号（两位，如 03），青色发光
        g.fillStyle = '#07100f'; g.fillRect(8, dy, S - 16, dispH);
        g.strokeStyle = '#3a4a48'; g.lineWidth = 1; g.strokeRect(8.5, dy + .5, S - 17, dispH - 1);
        g.fillStyle = '#6ff0d0'; g.shadowColor = '#39d8b4'; g.shadowBlur = 12;
        g.font = 'bold 40px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(cur + 1).padStart(2, '0'), S / 2, dy + dispH / 2 + 2);   // 楼层号与楼层设置一致：第 1 层显示 01（不再用 G）
        g.shadowBlur = 0;
        rows.forEach(r => {
          if (r.act === 'floor') {                                // 自顶向下 = 最高层 → 最低层
            const up = !!lights && lights.has(r.floor);            // 只有已登记的目标层亮灯；当前所在层由显示屏表达，按钮不额外高亮
            g.beginPath(); g.arc(r.cx, r.cy, 14, 0, Math.PI * 2);
            if (up) {                                             // 已登记的目标层：琥珀色亮灯 + 光晕（到站即熄灭）
              g.fillStyle = '#f2b03c'; g.shadowColor = '#ffcf6b'; g.shadowBlur = 10; g.fill(); g.shadowBlur = 0;
              g.strokeStyle = '#ffe6ab';
            } else {
              g.fillStyle = '#39424c'; g.fill();
              g.strokeStyle = '#586270';
            }
            g.lineWidth = up ? 2 : 1.5; g.stroke();
            g.fillStyle = up ? '#2a1c05' : '#fff'; g.font = 'bold 15px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(String(r.floor + 1), r.cx, r.cy + 1);
          } else {                                                // 开 / 关门按钮：底部左右两个方形
            g.fillStyle = '#39424c'; g.fillRect(r.cx - 17, r.cy - 15, 34, 30);
            g.strokeStyle = '#586270'; g.lineWidth = 1.5; g.strokeRect(r.cx - 17, r.cy - 15, 34, 30);
            g.fillStyle = '#dfe6ea'; g.font = 'bold 20px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(r.act === 'open' ? '‹›' : '›‹', r.cx, r.cy + 1);
          }
        });
      };
      const cur0 = Math.max(0, Math.min(floors.length - 1, Math.round(l.cur ?? 0)));
      paint(cur0, lit);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const PX = 600;                                            // 600px = 1m：面板宽 96px = 0.16m，按钮 / 字号比例自然
      const ph = Hpx / PX;
      // 命中盒：y = 距面板底米数；z = 沿门面的偏移（纹理右 = 世界 -Z）
      const hits = rows.map(r => ({ act: r.act, floor: r.floor, y: (Hpx - r.cy) / PX, z: (S / 2 - r.cx) / PX }));
      return { tex, ph, hits, setState: (c, lights) => { paint(c, lights); tex.needsUpdate = true; } };
    }
    function hallCallPanel(l, floor, oid) {                     // 建筑工具电梯门呼叫面板：楼层显示屏（联动电梯当前层）+ 单个呼叫按钮
      // floor：本门洞所在楼层索引（呼叫按钮送梯目标）；显示屏 label 仍取电梯当前层 l.cur
      // oid：门洞 id，用于判断「本层呼叫是不是这个门洞按的」，按钮只在呼梯登记后亮灯
      const fs = l && Array.isArray(l.floors) && l.floors.length ? l.floors : [l?.stop ?? 0];
      const S = 96, pad = 8, dispH = 58, btnH = 48;
      const Hpx = pad + dispH + 8 + btnH + pad;
      const cv = document.createElement('canvas'); cv.width = S; cv.height = Hpx;
      const g = cv.getContext('2d');
      const cy = pad + dispH + 8 + btnH / 2, cx = S / 2;
      const paint = (c, lights) => {                              // 整张重绘：显示屏跟随联动电梯当前层（运行跳层时由主循环调用）
        const cur = l ? Math.max(0, Math.min(fs.length - 1, Math.round(c ?? 0))) : -1;
        const label = cur < 0 ? '--' : String(cur + 1).padStart(2, '0');   // 未联动显示 --；联动时显示联动电梯当前层（第 1 层 = 01）
        g.fillStyle = '#1c2128'; g.fillRect(0, 0, S, Hpx);
        g.fillStyle = '#2b323c'; g.fillRect(2, 2, S - 4, Hpx - 4);
        g.fillStyle = '#07100f'; g.fillRect(8, pad, S - 16, dispH);
        g.strokeStyle = '#3a4a48'; g.lineWidth = 1; g.strokeRect(8.5, pad + .5, S - 17, dispH - 1);
        g.fillStyle = '#6ff0d0'; g.shadowColor = '#39d8b4'; g.shadowBlur = 12;
        g.font = 'bold 38px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(label, S / 2, pad + dispH / 2 + 2); g.shadowBlur = 0;
        const rq = l ? liftDoorReq.get(l.id) : null;              // 只认「这个门洞按下的呼叫」：轿厢内选层不会点亮层站按钮
        const on = !!l && !!lights && lights.has(best) && (!oid || (rq && rq.get(best) === oid));
        g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2);
        if (on) {                                                 // 已呼梯待乘：琥珀色亮灯 + 光晕（到站开门时熄灭）
          g.fillStyle = '#f2b03c'; g.shadowColor = '#ffcf6b'; g.shadowBlur = 10; g.fill(); g.shadowBlur = 0;
          g.strokeStyle = '#ffe6ab';
        } else {                                                  // 未呼叫：普通灰底，与轿厢内未登记按钮一致
          g.fillStyle = '#39424c'; g.fill(); g.strokeStyle = '#586270';
        }
        g.lineWidth = on ? 2 : 1.5; g.stroke();
        g.fillStyle = on ? '#2a1c05' : (l ? '#dfe6ea' : '#8b949e'); g.font = 'bold 21px sans-serif';
        g.fillText('↑', cx, cy + 1);
      };
      const best = l && floor != null ? Math.max(0, Math.min(fs.length - 1, Math.round(+floor || 0))) : 0;   // 呼叫到本门洞所在楼层
      const cur0 = l ? Math.max(0, Math.min(fs.length - 1, Math.round(l.cur ?? 0))) : -1;
      paint(cur0, l ? liftLit.get(l.id) : null);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const PX = 600, ph = Hpx / PX;
      // 命中盒用 y（距面板底米数）/ z（沿墙偏移），与 liftCallPanel 保持一致；只给 cy/cx 会让挂载处算出 NaN 而点不中
      return { tex, ph, hits: [{ act: 'hall', floor: best, y: (Hpx - cy) / PX, z: (S / 2 - cx) / PX }], setState: (c, lights) => { paint(c, lights); tex.needsUpdate = true; } };
    }
    function buildLift3D(l) {                                   // 电梯：井道四壁 + 门洞过梁 + 金属双扇门
      const W = Math.max(.8, (l.w ?? 2000) / 1000), D = Math.max(.8, (l.d ?? 2000) / 1000);
      const H = Math.max(1.8, Math.min(4, (l.h ?? 2400) / 1000));
      const DW = Math.max(.5, Math.min(W - .3, D - .3, (l.dw ?? 900) / 1000));   // 门宽（沿进深方向）
      const DOFF = Math.max(-(D - DW) / 2, Math.min((D - DW) / 2, (l.dpos ?? 0) / 1000));   // 门洞在门面上的偏移
      const DH = Math.max(1.2, Math.min((l.dh ?? 2100) / 1000, H - .1));         // 门高
      const B = Math.max(0, (l.stop ?? 0) / 1000 - floorY());   // 停靠高度：相对当前层基准，井道从这个高度向上建
      const g = new THREE.Group();
      g.position.set(wx(l.x), 0, wz(l.y)); tagPick(g, 'lift', l.id);
      g.rotation.y = -(l.dir || 0) * Math.PI / 180;              // 平面顺时针旋转 → 绕 Y 轴负向
      const t = .1, shMat = mat('#b9bcbd', { roughness: .7 }), doorMat = mat('#9aa2a8', { metalness: .7, roughness: .3 }), flMat = mat('#4d5257', { roughness: .85 });
      const add = (w, h, d, x, y, z, m) => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
        b.position.set(x, y + B, z); b.castShadow = b.receiveShadow = true; g.add(b);
      };
      add(W, .02, D, 0, .01, 0, flMat);                          // 停靠层底板
      add(t, H, D, -W / 2 + t / 2, H / 2, 0, shMat);             // 左壁（-X）
      add(W, H, t, 0, H / 2, -D / 2 + t / 2, shMat);             // 后壁（-Z）
      add(W, H, t, 0, H / 2, D / 2 - t / 2, shMat);              // 前壁（+Z）
      const z0 = DOFF - DW / 2, z1 = DOFF + DW / 2;              // 门洞位置（门在 +X 面，可沿进深偏移）
      const segA = z0 + D / 2, segB = D / 2 - z1;                 // 门洞两侧墙垛
      if (segA > .01) add(t, H, segA, W / 2 - t / 2, H / 2, -D / 2 + segA / 2, shMat);
      if (segB > .01) add(t, H, segB, W / 2 - t / 2, H / 2, z1 + segB / 2, shMat);
      const dH = DH, lH = H - dH;                                 // 门洞过梁
      if (lH > .01) add(t, lH, DW, W / 2 - t / 2, dH + lH / 2, DOFF, shMat);
      const leaf = DW / 2 + .01;                                  // 每扇略过半洞宽：闭合时中缝重叠，不留缝
      const dTh = Math.max(.04, t - .02);                         // 门扇厚度取井道壁厚 - 20mm：无门套时门扇与墙面几乎齐平，只留 10mm 凹缝
      const pocketA = Math.max(0, segA - .012), pocketB = Math.max(0, segB - .012);   // 门袋：门洞两侧墙垛内能藏下门扇的长度（不够时门只开到墙边）
      const edoor = { slide: true, lift: true, liftId: l.id, liftSource: 'car', open: false, cur: 0, pivots: [], y0: B, y1: B + dH, h: dH, group: g };   // 轿厢门：开合只由呼叫面板驱动（门扇不再挂点击标记），开门延时自动关
      {                                                     // 门洞中点世界坐标（自动关门时判断玩家是否还在门口 / 轿厢附近）
        const th0 = -(l.dir || 0) * Math.PI / 180;
        edoor.gx = wx(l.x) + W / 2 * Math.cos(th0) + DOFF * Math.sin(th0);
        edoor.gz = wz(l.y) - W / 2 * Math.sin(th0) + DOFF * Math.cos(th0);
        edoor.ex = Math.sin(th0); edoor.ez = Math.cos(th0);  // 门面展开方向（世界系）：光幕按此算沿门面偏移
        edoor.nx = Math.cos(th0); edoor.nz = -Math.sin(th0); // 门面法线（世界系）：光幕按此算门前后余量
        edoor.half = DW / 2; edoor.base = B; edoor.top = B + dH;
      }
      [-1, 1].forEach(sd => {
        const pg = new THREE.Group();
        pg.position.set(W / 2 - t / 2, 0, DOFF + sd * DW / 4);   // 门扇嵌在井道壁厚度中线：关时填满门洞，开时滑进两侧墙垛内部被墙挡住（真正收进电梯墙里，不再贴在墙面滑）
        const panel = new THREE.Mesh(new THREE.BoxGeometry(dTh, dH - .006, leaf), doorMat);
        panel.position.y = B + dH / 2 - .003; panel.castShadow = panel.receiveShadow = true;   // 门扇上下也贴到门槛与过梁
        if (sd === 1) {                                          // 中缝饰条：闭合时能看出是两扇，开合时随门扇滑走
          const seam = new THREE.Mesh(new THREE.BoxGeometry(dTh + .008, dH - .01, .02), frameMat);
          seam.position.set(0, 0, -DW / 4); seam.castShadow = true;
          panel.add(seam);
        }
        pg.add(panel);
        {                                                    // 门扇滑动方向在轿厢局部系里，预换算成世界系（blocked 用）；滑行距离不超过本侧门袋长度，避免门扇从井道壁外露出来
          const th = -(l.dir || 0) * Math.PI / 180;
          edoor.pivots.push({ g: pg, px: pg.position.x, pz: pg.position.z, ax: 0, az: sd, dist: Math.min(DW / 2, sd > 0 ? pocketB : pocketA), pw: leaf, ew: [Math.sin(th) * sd, Math.cos(th) * sd] });
        }
        g.add(pg);
      });
      // 轿厢门不设门套 / 门边框：门扇直接嵌在井道壁厚度里，关合时与墙面齐平（四周是墙体截面，没有包边立梃与上横梁）
      const sil = new THREE.Mesh(new THREE.BoxGeometry(t + .04, .02, DW + .04), doorMat);   // 门槛板：与地面齐平，盖住门洞下沿露出的深色井道底板（无门套后不再向两侧外挑）
      sil.position.set(W / 2 - (t + .04) / 2 + .02, B + .01, DOFF); sil.castShadow = sil.receiveShadow = true;
      g.add(sil);
      const elevatorLiftBtn = (id, act, floor) => ({ id, act, floor });            // 面板按钮的拾取数据
      // 楼层显示屏 + 楼层 / 开关门按钮纹理：只供轿厢内面板使用（电梯外部不设面板，层站呼梯统一走建筑工具「电梯门」门洞上的呼叫按钮）
      const cp = liftCallPanel(l, liftLit.get(l.id));                               // 已登记的目标层重建后仍保持亮灯
      regLiftDisp(l.id, cp);                                                       // 登记显示屏：运行跳层时实时刷新
      // 轿厢内控制面板：装在与门同一面墙（+X）的墙垛内侧、紧靠门洞右手边，正对轿厢内（-X）
      const cpW = .16;                                                              // 面板宽（沿墙面方向）
      const pierR = D / 2 - z1, pierL = z0 + D / 2;                                  // 门洞两侧墙垛长度（+Z 为站在轿厢内看门的右手边）
      const sideZ = pierR >= pierL ? 1 : -1;                                          // 优先右手边，太窄则换左手边
      const pier = Math.max(pierR, pierL);
      const ipz = pier >= cpW + .06                                                   // 墙垛够宽：贴门洞边留 40mm；不够宽：居中放（面板略越出墙垛也不进洞口）
        ? (sideZ > 0 ? z1 + .04 + cpW / 2 : z0 - .04 - cpW / 2)
        : (sideZ > 0 ? z1 + pierR / 2 : z0 - pierL / 2);
      const ipx = W / 2 - t - .011;                                                   // 背板中心：从 +X 壁内表面向轿厢内凸 22mm（在门扇内侧，开门滑行不打架）
      const icpY = B + Math.min(1.02, Math.max(.35, dH - cp.ph - .06));                // 面板底标高：按真人抬手高度取 1.0m 左右
      const ibg = new THREE.Mesh(new THREE.BoxGeometry(.022, cp.ph + .02, cpW + .02), frameMat);
      ibg.position.set(ipx, icpY + cp.ph / 2, ipz); ibg.castShadow = true; g.add(ibg);
      const iface = new THREE.Mesh(new THREE.PlaneGeometry(cpW, cp.ph), new THREE.MeshBasicMaterial({ map: cp.tex, toneMapped: false }));
      iface.rotation.y = -Math.PI / 2; iface.position.set(ipx - .012, icpY + cp.ph / 2, ipz); g.add(iface);   // 法线朝 -X（轿厢内）
      cp.hits.forEach(h => {                                                          // 内侧命中盒：面板朝 -X，纹理左右沿 -Z（与外面板相反），朝轿厢内再偏 30mm
        const hit = new THREE.Mesh(new THREE.BoxGeometry(.02, .038, .05), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
        hit.position.set(ipx - .03, icpY + h.y, ipz - h.z); hit.userData.liftBtn = elevatorLiftBtn(l.id, h.act, h.floor); g.add(hit);
      });
      doors.push(edoor);
      archUp.add(g);
      const th = -(l.dir || 0) * Math.PI / 180, ct = Math.cos(th), st = Math.sin(th);
      const pushCol = (lx0, lz0, lx1, lz1) => {                  // 井道壁逐面占位（门洞处留缺口）：门开 / 自动滑开后可走进轿厢，整体外接盒会把轿厢变成进不去的实心块
        const px = [lx0 * ct + lz0 * st, lx1 * ct + lz1 * st], pz = [-lx0 * st + lz0 * ct, -lx1 * st + lz1 * ct];
        const c = [wx(l.x) + Math.min(...px), wz(l.y) + Math.min(...pz), wx(l.x) + Math.max(...px), wz(l.y) + Math.max(...pz), B, B + H];
        c.liftId = l.id; c.liftY0 = B; c.liftY1 = B + H; colliders.push(c);   // 标记电梯壁碰撞，运行时随轿厢高度整体平移
      };
      pushCol(-W / 2, -D / 2, -W / 2 + t, D / 2);                // 左壁（-X）
      pushCol(-W / 2, -D / 2, W / 2, -D / 2 + t);                // 后壁（-Z）
      pushCol(-W / 2, D / 2 - t, W / 2, D / 2);                  // 前壁（+Z）
      pushCol(W / 2 - t, -D / 2, W / 2, z0);                     // 门洞侧墙垛（+X）
      pushCol(W / 2 - t, z1, W / 2, D / 2);
    }
    function buildOpening3D(A, B, o, top, T) {
      if (o.kind === 'lbay') {                                    // 转角飘窗：两段各自建，共用窗台 / 窗高 / 进深
        const lgs = (o.legs || []).map(leg => {
          const lg = openingWallGeom(leg.wall); if (!lg) return null;
          const [PA, PB] = segPts(lg.A, lg.B, leg.c - leg.w / 2, leg.c + leg.w / 2);   // leg.c 为段中心
          return { PA, PB, leg, lg };
        }).filter(Boolean);
        const both = lgs.length === 2;                            // 两段都在：台板 / 坐板改为转角处整条生成（同一块板），避免三块板搭接错台
        lgs.forEach(({ PA, PB, leg, lg }) => buildOpening3D(PA, PB, { ...o, kind: 'bay', c: 0, w: leg.w, bayFlip: leg.flip, lcorner: leg.lc, noPlate: both, panes: leg.panes ?? o.panes }, top, lg.T));
        if (both) buildLBayCorner3D(o, lgs, top);                  // 转角补齐：缺的台板与玻璃
        return;
      }
      const WL = Math.hypot(B[0] - A[0], B[1] - A[1]);               // 墙可能被改短：把门窗钳回墙内再建
      let c0 = Math.max(0, Math.min(o.c, WL)), c1 = Math.max(0, Math.min(WL, o.c + o.w));
      if (c1 - c0 < 10) return;
      if (o.kind === 'fwin' && o.cg) {                               // 转角窗：与 2D 一致，窗段贴到墙角（400mm 内）时延伸到墙面外沿，否则墙垛被抑制处会留下通高缝
        if (c0 > 0 && c0 <= 400) c0 = 0;
        if (c1 < WL && c1 >= WL - 400) c1 = WL;
      }
      o = { ...o, c: c0, w: c1 - c0 };
      const [P0, P1] = segPts(A, B, o.c, o.c + o.w);
      const dB = Math.max(0, Math.min((o.sill ?? 0) / 1000, top - .5));            // 门槛高：门洞下沿离地
      const dT = dB + Math.max(.5, Math.min((o.dh ?? 2100) / 1000, top - dB));     // 门洞顶标高
      if (o.kind === 'door') {
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);          // 门槛下的矮墙
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);         // 门洞上方过梁
        const inset = Math.min(60, o.w * .1);                // 门套占位：门扇两侧各让出 60mm
        addDoorLeaf(A, B, { ...o, c: o.c + inset, w: o.w - inset * 2 }, top, dB, dT - dB);
        addDoorCasing(P0, P1, dB, dT, T, doorCasingMat(o));
        return;                                              // 门洞不设碰撞，可通行
      }
      if (o.kind === 'yak') {                                // 垭口：只有洞口 + 门套，无门扇（可直接穿行）
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);         // 洞上方过梁
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T), hh = dT - dB, cm = doorCasingMat(o);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        [-L / 2 + .03, L / 2 - .03].forEach(off => {         // 两侧门套立梃
          const post = new THREE.Mesh(new THREE.BoxGeometry(.06, hh, TT * 1.04), cm);
          post.position.set(mx + dx * off, dB + hh / 2, mz + dz * off); post.castShadow = true; archUp.add(post);
        });
        const head = new THREE.Mesh(new THREE.BoxGeometry(L, .1, TT * 1.04), cm);   // 门套横头
        head.position.set(mx, dT - .05, mz); head.rotation.y = rot; head.castShadow = true; archUp.add(head);
        return;
      }
      if (o.kind === 'arch') {                               // 拱形门洞：直段 + 上方挖半椭圆拱洞的墙板 + 弧形门套
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const spring = Math.max(.3, Math.min((o.sh ?? 2100) / 1000, top - .3));
        const rise = Math.max(.1, Math.min((o.rise ?? 600) / 1000, L / 2, top - spring));
        const head = spring + rise;
        if (top > head + .001) {                             // 拱顶以上墙段：外轮廓直接画成拱形墙（顶部平、底部拱）
          const hh = top - spring, r = L / 2, shp = new THREE.Shape();
          shp.moveTo(-r, 0); shp.lineTo(-r, hh); shp.lineTo(r, hh); shp.lineTo(r, 0);
          shp.absellipse(0, 0, r, rise, 0, Math.PI, false);   // 底部沿上半椭圆回到左侧
          shp.closePath();
          const geo = new THREE.ExtrudeGeometry(shp, { depth: TT, bevelEnabled: false, curveSegments: 24 });
          geo.translate(0, 0, -TT / 2);
          const panel = new THREE.Mesh(geo, wallMat);
          panel.position.set(mx, spring, mz); panel.rotation.y = rot;
          panel.castShadow = panel.receiveShadow = true; archUp.add(panel);
          const capGeo = new THREE.PlaneGeometry(L, TT);       // 与普通墙段一致，顶面使用深色压顶材质
          capGeo.rotateX(-Math.PI / 2);
          const cap = new THREE.Mesh(capGeo, capMat);
          cap.position.set(mx, top + .0006, mz); cap.rotation.y = rot; archUp.add(cap);
        }
        const grp = new THREE.Group();                       // 门套与普通房门一致：50mm 宽，墙面外挑 10mm，材质可选
        grp.position.set(mx, spring, mz); grp.rotation.y = rot; archUp.add(grp);
        const frameW = .05, frameR = frameW / 2, cm = doorCasingMat(o);
        [-L / 2 + frameR, L / 2 - frameR].forEach(off => {
          const post = new THREE.Mesh(new THREE.BoxGeometry(frameW, spring, TT + .02), cm);
          post.position.set(off, -spring / 2, 0); post.castShadow = true; grp.add(post);
        });
        const innerRx = Math.max(.02, L / 2 - frameW), innerRy = Math.max(.02, rise - frameW);
        const band = new THREE.Shape();                       // 扁平弧形门套：外椭圆弧 + 内椭圆弧围成 50mm 宽边框
        band.moveTo(L / 2, 0);
        band.absellipse(0, 0, L / 2, rise, 0, Math.PI, false);
        band.lineTo(-innerRx, 0);
        band.absellipse(0, 0, innerRx, innerRy, Math.PI, 0, true);
        band.closePath();
        const bandDepth = TT + .02;
        const bandGeo = new THREE.ExtrudeGeometry(band, { depth: bandDepth, bevelEnabled: false, curveSegments: 24 });
        bandGeo.translate(0, 0, -bandDepth / 2);
        const archFrame = new THREE.Mesh(bandGeo, cm);
        archFrame.castShadow = true; grp.add(archFrame);
        return;
      }
      if (o.kind === 'niche') {                              // 壁龛：洞口内的背板 + 四壁内衬 + 前口边框
        const sill = Math.max(0, Math.min((o.sill ?? 900) / 1000, top - .4));       // 龛底标高
        const wh = Math.max(.2, Math.min((o.wh ?? 700) / 1000, top - sill - .05));   // 龛高
        const head = sill + wh, L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const dep = Math.max(.05, Math.min((o.nd ?? 250) / 1000, TT - .03));         // 龛深
        wallSeg3D(P0, P1, T, 0, sill);                       // 龛下墙
        if (top > head + .001) wallSeg3D(P0, P1, T, head, top);       // 龛上墙
        pushSillCollider(P0, P1, T, sill);                   // 龛下矮墙挡路（高于半步时人不能从龛位穿墙）
        const side = o.flip ? 1 : -1, openZ = side * TT / 2, backZ = side * (TT / 2 - dep);
        const grp = new THREE.Group(); grp.position.set(mx, 0, mz); grp.rotation.y = rot; archUp.add(grp);
        const inMat = mat('#e6ddcd', { roughness: .95 }), trimMat = mat('#d8cbb4', { roughness: .8 });
        const add = (w, h, d, x, y, z, m) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
          b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; grp.add(b);
        };
        add(L - .02, wh, .02, 0, sill + wh / 2, backZ, inMat);                 // 背板
        add(L, wh, TT - dep, 0, sill + wh / 2, -side * dep / 2, wallMat);      // 龛背后的墙：壁龛只做单面内凹，不能把整面墙打穿
        [-1, 1].forEach(sd => add(.02, wh, dep, sd * (L / 2 - .01), sill + wh / 2, (openZ + backZ) / 2, inMat));   // 左右内壁
        [sill + .01, head - .01].forEach(y => add(L - .02, .02, dep, 0, y, (openZ + backZ) / 2, inMat));            // 上下内壁
        [-1, 1].forEach(sd => add(.05, wh + .08, .03, sd * (L / 2 - .025), sill + wh / 2, openZ, trimMat));         // 前口竖边框
        [sill - .02, head + .02].forEach(y => add(L, .05, .03, 0, y, openZ, trimMat));                              // 前口上下边框
        return;
      }
      if (o.kind === 'hole') {                               // 预留洞 / 窗洞：只开洞，不加窗框与玻璃
        const sill = Math.max(0, Math.min((o.sill ?? 900) / 1000, top - .2));
        const wh = Math.max(.2, (o.wh ?? 900) / 1000);
        const head = Math.min(sill + wh, top);
        wallSeg3D(P0, P1, T, 0, sill);
        if (top > head + .001) wallSeg3D(P0, P1, T, head, top);
        pushSillCollider(P0, P1, T, sill);                   // 洞下矮墙挡路（洞开在半空，人不能从洞位穿墙而过）
        return;
      }
      if (o.kind === 'dble' || o.kind === 'zimu') {          // 双开门 / 子母门：两扇对开（子母门大扇在左）
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);         // 门洞上方过梁
        const fr = o.kind === 'dble' ? .5 : .62;
        const inset = Math.min(60, o.w * .06), uw = Math.max(.2, o.w - inset * 2);   // 门套占位
        addDoorLeaf(A, B, { ...o, c: o.c + inset, w: uw * fr, hflip: false }, top, dB, dT - dB);                  // 左扇（铰链在左端）
        addDoorLeaf(A, B, { ...o, c: o.c + inset + uw * fr, w: uw * (1 - fr), hflip: true }, top, dB, dT - dB);    // 右扇（铰链在右端）
        addDoorCasing(P0, P1, dB, dT, T, doorCasingMat(o));
        return;
      }
      if (o.kind === 'dwin') {                               // 门连窗：一侧门扇 + 另一侧可开启窗（hflip 左右互换）
        const dWMM = Math.min(900, Math.round(o.w * .6)), wWMM = o.w - dWMM;
        const d0 = o.hflip ? wWMM : 0;                       // 门扇在洞口内的起点
        const [PA, PB] = segPts(A, B, o.c + d0, o.c + d0 + dWMM);
        const [PC, PD] = o.hflip ? segPts(A, B, o.c, o.c + wWMM) : segPts(A, B, o.c + dWMM, o.c + o.w);   // 窗段
        if (dB > .001) wallSeg3D(PA, PB, T, 0, dB);
        pushSillCollider(PA, PB, T, dB);
        if (top > dT) wallSeg3D(PA, PB, T, dT, top);         // 门上方过梁
        const inset = Math.min(60, dWMM * .1);               // 门套占位：门扇两侧各让出 60mm
        addDoorLeaf(A, B, { ...o, c: o.c + d0 + inset, w: dWMM - inset * 2, hflip: !!o.hflip }, top, dB, dT - dB);
        addDoorCasing(PA, PB, dB, dT, T, doorCasingMat(o));
        if (wWMM > 100) {
          const gTop = Math.min(2.4, top), sillW = Math.min(.9, gTop - .1);
          const availH = gTop - sillW;
          const thM = Math.min(Math.max(.15, (o.th ?? 500) / 1000), Math.max(.15, availH - .2));   // 窗花高度
          const sTop = o.grille === true ? Math.max(sillW + .2, gTop - thM) : gTop;                 // 窗扇区顶
          wallSeg3D(PC, PD, T, 0, sillW);                    // 窗下墙
          if (top > gTop) wallSeg3D(PC, PD, T, gTop, top);   // 窗上过梁
          const Lw = M(wWMM), rotW = wallAngle(PC, PD), [mxW, mzW] = wallMid(PC, PD);
          const ux = (wx(PD[0]) - wx(PC[0])) / Lw, uz = (wz(PD[1]) - wz(PC[1])) / Lw;
          if (o.grille === true && gTop - sTop > .02) {      // 窗花：窗扇上方的横向带框固定玻璃（亮子）
            const bh = gTop - sTop;
            const bpane = new THREE.Mesh(new THREE.BoxGeometry(Lw, bh, .012), glassMat);
            bpane.position.set(mxW, sTop + bh / 2, mzW); bpane.rotation.y = rotW; archUp.add(bpane);
            [-Lw / 2 + .025, Lw / 2 - .025].forEach(off => {   // 亮子左右竖梃
              const bar = new THREE.Mesh(new THREE.BoxGeometry(.05, bh, .06), frameMat);
              bar.position.set(mxW + ux * off, sTop + bh / 2, mzW + uz * off); bar.rotation.y = rotW; archUp.add(bar);
            });
            [sTop + .025, gTop - .025].forEach(y => {          // 亮子下 / 上横梃
              const bar = new THREE.Mesh(new THREE.BoxGeometry(Lw, .05, .06), frameMat);
              bar.position.set(mxW, y, mzW); bar.rotation.y = rotW; archUp.add(bar);
            });
          }
          const side = o.flip ? -1 : 1, ox = -uz * side, oz = ux * side;   // 朝窗外的法向
          const ns = Math.max(1, Math.round(Lw / .8));       // 窗扇按约 800mm 分扇，点玻璃或扇框即可推开 / 关上
          for (let k = 0; k < ns; k++) {
            const t0 = Lw * k / ns, t1 = Lw * (k + 1) / ns, rev = k % 2 === 1;   // 隔扇换铰链边，向外开不互相挡
            const a = [wx(PC[0]) + ux * t0, wz(PC[1]) + uz * t0], b = [wx(PC[0]) + ux * t1, wz(PC[1]) + uz * t1];
            addBaySash(rev ? b : a, rev ? a : b, sillW, Math.max(.2, sTop - sillW), ox, oz);
          }
          pushWallCollider(PC, PD, T, top);                   // 窗下不能穿行
        }
        return;
      }
      if (o.kind === 'louver') {                             // 百叶窗：窗洞 + 倾斜叶片（固定，不可开启）
        const sill = Math.max(0, Math.min((o.sill ?? 900) / 1000, top - .3));
        const wh = Math.max(.3, Math.min((o.wh ?? 1200) / 1000, top - sill));
        const head = sill + wh, L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        wallSeg3D(P0, P1, T, 0, sill);                       // 窗下墙
        if (top > head) wallSeg3D(P0, P1, T, head, top);     // 窗上过梁
        [-L / 2 + .025, L / 2 - .025].forEach(off => {       // 左右竖梃
          const m = new THREE.Mesh(new THREE.BoxGeometry(.05, wh, .07), frameMat);
          m.position.set(mx + dx * off, sill + wh / 2, mz + dz * off); m.rotation.y = rot; m.castShadow = true; archUp.add(m);
        });
        [sill + .025, head - .025].forEach(y => {            // 上下横梃
          const m = new THREE.Mesh(new THREE.BoxGeometry(L, .05, .07), frameMat);
          m.position.set(mx, y, mz); m.rotation.y = rot; m.castShadow = true; archUp.add(m);
        });
        const slatMat = mat('#b9c2c7', { roughness: .5, metalness: .25 });
        const nS = Math.max(3, Math.round(wh / .12));
        for (let k = 0; k < nS; k++) {                       // 叶片：绕墙轴倾斜约 37°
          const sl = new THREE.Mesh(new THREE.BoxGeometry(L - .07, .02, .11), slatMat);
          sl.position.set(mx, sill + (k + .5) * wh / nS, mz);
          sl.rotation.set(0, rot, 0); sl.rotateX(-.65); sl.castShadow = true; archUp.add(sl);
        }
        pushWallCollider(P0, P1, T, top);
        return;
      }
      if (o.kind === 'cwin') {                               // 圆窗：方板挖圆洞补墙 + 圆形窗框、玻璃与十字分格
        const sill = Math.max(0, Math.min((o.sill ?? 900) / 1000, top - .35));
        const d = Math.max(.3, Math.min(M(o.w), top - sill));        // 圆直径 = 窗宽
        const head = sill + d, L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        wallSeg3D(P0, P1, T, 0, sill);                       // 窗下墙
        if (top > head + .001) wallSeg3D(P0, P1, T, head, top);      // 窗上过梁
        const shp = new THREE.Shape();                       // 方形补板，中间挖圆洞
        shp.moveTo(-L / 2, 0); shp.lineTo(L / 2, 0); shp.lineTo(L / 2, d); shp.lineTo(-L / 2, d); shp.closePath();
        const hole = new THREE.Path(); hole.absarc(0, d / 2, d / 2 - .001, 0, Math.PI * 2, true); shp.holes.push(hole);
        const geo = new THREE.ExtrudeGeometry(shp, { depth: TT, bevelEnabled: false });
        geo.translate(0, 0, -TT / 2);
        const panel = new THREE.Mesh(geo, wallMat);
        panel.position.set(mx, sill, mz); panel.rotation.y = rot; panel.castShadow = panel.receiveShadow = true; archUp.add(panel);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(d / 2 - .02, .035, 10, 40), frameMat);
        ring.position.set(mx, sill + d / 2, mz); ring.rotation.y = rot; ring.castShadow = true; archUp.add(ring);
        const pane = new THREE.Mesh(new THREE.CircleGeometry(d / 2 - .02, 40), glassMat);
        pane.position.set(mx, sill + d / 2, mz); pane.rotation.y = rot; archUp.add(pane);     // 玻璃（双面材质）
        [[.035, d - .04], [d - .04, .035]].forEach(([w, h]) => {     // 十字分格
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, .05), frameMat);
          m.position.set(mx, sill + d / 2, mz); m.rotation.y = rot; m.castShadow = true; archUp.add(m);
        });
        pushWallCollider(P0, P1, T, top);
        return;
      }
      if (o.kind === 'venthole') {                           // 过墙排风口：方板挖圆洞补墙 + 穿墙套管（PVC 圆管沿墙法线贯穿），不装窗框玻璃
        const c = Math.max(0, Math.min(M(o.sill ?? 2400), top - .12));   // 孔中心标高（m），上下留 120mm 墙垛
        const d = Math.max(.06, Math.min(M(o.w), Math.min(c, top - c) * 2 - .02));   // 圆孔直径，不越出上下墙边
        const L = d, rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const sill = c - d / 2, head = c + d / 2;
        wallSeg3D(P0, P1, T, 0, sill);                       // 孔下墙
        if (top > head + .001) wallSeg3D(P0, P1, T, head, top);   // 孔上墙
        const shp = new THREE.Shape();                       // 方形补板，中间挖圆洞
        shp.moveTo(-L / 2, 0); shp.lineTo(L / 2, 0); shp.lineTo(L / 2, d); shp.lineTo(-L / 2, d); shp.closePath();
        const hole = new THREE.Path(); hole.absarc(0, d / 2, d / 2 - .001, 0, Math.PI * 2, true); shp.holes.push(hole);
        const geo = new THREE.ExtrudeGeometry(shp, { depth: TT, bevelEnabled: false });
        geo.translate(0, 0, -TT / 2);
        const panel = new THREE.Mesh(geo, wallMat);
        panel.position.set(mx, sill, mz); panel.rotation.y = rot; panel.castShadow = panel.receiveShadow = true; archUp.add(panel);
        const sleeveMat = mat('#b9b3a5', { roughness: .75, metalness: .1 });   // PVC 套管：略长于墙厚，两端各露出一点
        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(d / 2 - .004, d / 2 - .004, TT + .05, 28, 1, true), sleeveMat);
        sleeve.rotation.x = Math.PI / 2;   // 圆柱从沿 Y 转到沿墙法线（本地 Z）
        const sleeveGrp = new THREE.Group(); sleeveGrp.position.set(mx, c, mz); sleeveGrp.rotation.y = rot;   // 随墙朝向
        sleeveGrp.add(sleeve); archUp.add(sleeveGrp);
        pushWallCollider(P0, P1, T, top);                    // 圆孔很小，整墙仍挡人（不因开孔可穿行）
        return;
      }
      if (o.kind === 'sqventhole') {                         // 矩形过墙排风口：方板挖矩形洞补墙 + 穿墙方管套管（沿墙法线贯穿），不装窗框玻璃
        const c = Math.max(0, Math.min(M(o.sill ?? 2400), top - .12));   // 孔中心标高（m），上下留 120mm 墙垛
        const L = Math.max(.06, M(o.w));                     // 孔宽：沿墙方向
        const dh = Math.max(.06, Math.min(M(o.wh ?? o.w), Math.min(c, top - c) * 2 - .02));   // 孔高：垂直方向，不越出上下墙边
        const rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const sill = c - dh / 2, head = c + dh / 2;
        wallSeg3D(P0, P1, T, 0, sill);                       // 孔下墙
        if (top > head + .001) wallSeg3D(P0, P1, T, head, top);   // 孔上墙
        const shp = new THREE.Shape();                       // 方形补板，中间挖矩形洞
        shp.moveTo(-L / 2, 0); shp.lineTo(L / 2, 0); shp.lineTo(L / 2, dh); shp.lineTo(-L / 2, dh); shp.closePath();
        const hole = new THREE.Path();                       // 矩形洞轮廓（顺时针，作为挖空孔）
        const hiw = L / 2 - .001, hih = dh / 2 - .001;
        hole.moveTo(-hiw, dh / 2 - hih); hole.lineTo(hiw, dh / 2 - hih); hole.lineTo(hiw, dh / 2 + hih); hole.lineTo(-hiw, dh / 2 + hih); hole.closePath();
        shp.holes.push(hole);
        const geo = new THREE.ExtrudeGeometry(shp, { depth: TT, bevelEnabled: false });
        geo.translate(0, 0, -TT / 2);
        const panel = new THREE.Mesh(geo, wallMat);
        panel.position.set(mx, sill, mz); panel.rotation.y = rot; panel.castShadow = panel.receiveShadow = true; archUp.add(panel);
        const sleeveMat = mat('#b9b3a5', { roughness: .75, metalness: .1 });   // PVC 方管：四片薄板围成，略长于墙厚两端露出
        const sleeveGrp = new THREE.Group(); sleeveGrp.position.set(mx, c, mz); sleeveGrp.rotation.y = rot;
        const th = Math.max(.006, Math.min(.012, Math.min(L, dh) * .08)), tube = TT + .05;
        const plate = (w, h, x, y) => {                      // 在补板局部坐标里贴一片套管壁（本地 Z 沿墙法线）
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, tube), sleeveMat);
          m.position.set(x, y, 0); m.castShadow = true; sleeveGrp.add(m);
        };
        plate(L, th, 0, dh / 2 - th / 2); plate(L, th, 0, -dh / 2 + th / 2);   // 上 / 下壁（跨整个孔宽）
        plate(th, dh - th * 2, L / 2 - th / 2, 0); plate(th, dh - th * 2, -L / 2 + th / 2, 0);   // 左 / 右壁（净高）
        archUp.add(sleeveGrp);
        pushWallCollider(P0, P1, T, top);                    // 方孔很小，整墙仍挡人（不因开孔可穿行）
        return;
      }
      if (o.kind === 'bay') {                                // 飘窗：外凸的窗台体 + 正面 / 两侧玻璃 + 竖梃
        const sill = Math.max(0, Math.min((o.sill ?? 500) / 1000, top - .5));
        const wh = Math.max(.4, Math.min((o.wh ?? 1200) / 1000, top - sill));
        const head = sill + wh, L = M(o.w), dep = Math.max(.15, Math.min((o.bayDepth ?? 600) / 1000, 1.5));
        const rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        const side = o.bayFlip ? -1 : 1, nx = -dz * side, nz = dx * side;   // 外凸方向（墙面法向）
        wallSeg3D(P0, P1, T, 0, sill);                       // 窗下墙
        if (top > head) wallSeg3D(P0, P1, T, head, top);     // 窗上过梁
        const cx = mx + nx * dep / 2, cz = mz + nz * dep / 2;
        const lcEnd = o.lcorner || 0;                         // 转角飘窗的转角端：台板收到洞口边，交给转角台板拼接
        if (!o.noPlate) {                                     // 转角飘窗（两段都在）时台板 / 坐板由 buildLBayCorner3D 整条生成，这里不再各段各出一块
          const drip = BAY_DRIP;                              // 顶板 / 窗台板统一外挑（挡雨滴水），上下挑出同样尺寸
          const slabL = L + (lcEnd ? .03 : .06), slabOff = -lcEnd * .015, slabD = dep + drip + .015;
          const dOff = (drip - .015) / 2;                     // 进深从墙内侧 -15mm 挑到 dep + drip，中心随之外移
          const sx = cx + dx * slabOff + nx * dOff, sz = cz + dz * slabOff + nz * dOff;
          [sill - .03, head + .03].forEach(y => {             // 上下窗台板：厚 60mm，外挑起挡雨檐
            const slab = new THREE.Mesh(new THREE.BoxGeometry(slabL, .06, slabD), frameMat);
            slab.position.set(sx, y, sz); slab.rotation.y = rot;
            slab.castShadow = slab.receiveShadow = true; archUp.add(slab);
          });
          const seat = new THREE.Mesh(new THREE.BoxGeometry(L, .04, dep), mat('#e9e2d4', { roughness: .9 }));   // 窗台坐板
          seat.position.set(cx, sill + .02, cz); seat.rotation.y = rot; seat.receiveShadow = true; archUp.add(seat);
        }
        if (o.bayCurve) {                                     // 弧形飘窗：正面为圆弧玻璃（平面片近似），两端接墙面
          const R = (L * L / 4 + dep * dep) / (2 * dep);      // 弦长 L、矢高 dep 的圆弧半径
          const pcx = mx - nx * (R - dep), pcz = mz - nz * (R - dep);   // 圆心（室内侧）
          const phi = Math.asin(Math.min(1, L / (2 * R))), nS = Math.max(5, Math.round(L / .35));
          for (let i = 0; i < nS; i++) {
            const f0 = -phi + 2 * phi * i / nS, f1 = -phi + 2 * phi * (i + 1) / nS, fm = (f0 + f1) / 2;
            const dirX = dx * Math.sin(fm) + nx * Math.cos(fm), dirZ = dz * Math.sin(fm) + nz * Math.cos(fm);
            addBarrier(pcx + (dx * Math.sin(f0) + nx * Math.cos(f0)) * R, pcz + (dz * Math.sin(f0) + nz * Math.cos(f0)) * R,
              pcx + (dx * Math.sin(f1) + nx * Math.cos(f1)) * R, pcz + (dz * Math.sin(f1) + nz * Math.cos(f1)) * R, sill, head, .1);   // 弧玻璃逐段挡人
            const seg = 2 * R * Math.sin((f1 - f0) / 2) + .004;
            const g = new THREE.Mesh(new THREE.BoxGeometry(seg, wh, .02), glassMat);
            g.position.set(pcx + dirX * R, sill + wh / 2, pcz + dirZ * R);
            g.rotation.y = Math.atan2(dirX, -dirZ);
            archUp.add(g);
          }
          [phi, -phi].forEach(f2 => {                         // 两端角竖梃
            const dirX = dx * Math.sin(f2) + nx * Math.cos(f2), dirZ = dz * Math.sin(f2) + nz * Math.cos(f2);
            const p = new THREE.Mesh(new THREE.BoxGeometry(.06, wh, .06), frameMat);
            p.position.set(pcx + dirX * R, sill + wh / 2, pcz + dirZ * R);
            p.rotation.y = Math.atan2(dirX, -dirZ); p.castShadow = true; archUp.add(p);
          });
          pushWallCollider(P0, P1, T, top);
          return;
        }
        const nP = Math.max(1, Math.min(8, Math.round(o.panes ?? 3))), pw = L / nP;
        for (let i = 0; i < nP; i++) {                        // 正面玻璃按「窗扇数」分扇，相邻两扇左右对开
          const a = -L / 2 + i * pw + .012, b = -L / 2 + (i + 1) * pw - .012;
          const q0 = [mx + dx * a + nx * dep, mz + dz * a + nz * dep];
          const q1 = [mx + dx * b + nx * dep, mz + dz * b + nz * dep];
          if (i % 2) addBaySash(q1, q0, sill, wh, nx, nz);    // 奇数扇换到另一侧铰接，形成两两对开
          else addBaySash(q0, q1, sill, wh, nx, nz);
        }
        [-1, 1].forEach(sd => {                              // 两侧玻璃（沿进深方向、靠墙）：固定玻璃，不可开启
          if (o.lcorner === sd) return;                       // 转角飘窗：转角那侧不封玻璃
          addBarrier(mx + dx * sd * L / 2, mz + dz * sd * L / 2, mx + dx * sd * L / 2 + nx * dep, mz + dz * sd * L / 2 + nz * dep, sill, head, .1);   // 侧玻璃挡人：飘窗凸出体不能穿过
          const gp = new THREE.Mesh(new THREE.BoxGeometry(dep, wh, .02), glassMat);
          gp.position.set(mx + dx * sd * L / 2 + nx * dep / 2, sill + wh / 2, mz + dz * sd * L / 2 + nz * dep / 2);
          gp.rotation.y = rot + Math.PI / 2; archUp.add(gp);
        });
        [[-L / 2, 0], [L / 2, 0]].forEach(([so]) => {        // 靠墙两角的竖梃
          if (o.lcorner === Math.sign(so)) return;
          const p = new THREE.Mesh(new THREE.BoxGeometry(.06, wh, .06), frameMat);
          p.position.set(mx + dx * so, sill + wh / 2, mz + dz * so); p.rotation.y = rot; p.castShadow = true; archUp.add(p);
        });
        [[-L / 2, dep], [L / 2, dep]].forEach(([so, dd]) => {   // 外侧两角的竖梃
          const p = new THREE.Mesh(new THREE.BoxGeometry(.06, wh, .06), frameMat);
          p.position.set(mx + dx * so + nx * dd, sill + wh / 2, mz + dz * so + nz * dd);
          p.rotation.y = rot; p.castShadow = true; archUp.add(p);
        });
        for (let i = 1; i < nP; i++) {                       // 正面中竖梃（按窗扇数等分）
          const so = -L / 2 + i * pw;
          const p = new THREE.Mesh(new THREE.BoxGeometry(.045, wh, .05), frameMat);
          p.position.set(mx + dx * so + nx * dep, sill + wh / 2, mz + dz * so + nz * dep);
          p.rotation.y = rot; p.castShadow = true; archUp.add(p);
        }
        [sill + .025, head - .025].forEach(y => {            // 正面上下横梃
          const b = new THREE.Mesh(new THREE.BoxGeometry(L, .05, .06), frameMat);
          b.position.set(mx + nx * dep, y, mz + nz * dep); b.rotation.y = rot; b.castShadow = true; archUp.add(b);
        });
        pushWallCollider(P0, P1, T, top);                    // 窗洞处不可穿行
        return;
      }
      if (o.kind === 'strip') {                              // 带形窗：通长玻璃带 + 约 1200 分格竖梃
        const sill = Math.max(0, Math.min((o.sill ?? 600) / 1000, top - .4));
        const wh = Math.max(.3, Math.min((o.wh ?? 1500) / 1000, top - sill));
        const head = sill + wh, L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        wallSeg3D(P0, P1, T, 0, sill);                        // 窗下墙
        if (top > head) wallSeg3D(P0, P1, T, head, top);      // 窗上过梁
        const pane = new THREE.Mesh(new THREE.BoxGeometry(L - .02, wh, .012), glassMat);
        pane.position.set(mx, sill + wh / 2, mz); pane.rotation.y = rot; archUp.add(pane);
        const nM = Math.max(1, Math.round(L / 1.2));
        for (let k = 0; k <= nM; k++) {                       // 端部 + 等距竖梃
          const off = -L / 2 + L * k / nM;
          const mu = new THREE.Mesh(new THREE.BoxGeometry(.05, wh, .07), frameMat);
          mu.position.set(mx + dx * off, sill + wh / 2, mz + dz * off); mu.rotation.y = rot; mu.castShadow = true; archUp.add(mu);
        }
        [sill + .025, head - .025].forEach(y => {             // 上下横梃
          const bar = new THREE.Mesh(new THREE.BoxGeometry(L, .05, .07), frameMat);
          bar.position.set(mx, y, mz); bar.rotation.y = rot; bar.castShadow = true; archUp.add(bar);
        });
        pushWallCollider(P0, P1, T, top);
        return;
      }
      if (o.kind === 'auto') {                                // 自动感应门：双扇平移玻璃 + 门机箱 + 顶部感应器；漫游靠近自动滑开、离开关上
        const hh = Math.max(.5, dT - dB), L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);
        const pw = L / 2 - .001;                              // 每扇比半洞宽小 1mm，关闭时中缝约 2mm（自动对开门两扇齐平，不留大缝）
        const adoor = { slide: true, auto: true, open: false, cur: 0, pivots: [], mx, mz, half: L / 2, base: dB, top: dT };
        [-1, 1].forEach(sd => {                               // 两扇齐平同一平面，各占一半；整扇装进 group，开启时沿墙向各自一侧滑入门机箱
          const pg = new THREE.Group();
          pg.position.set(mx + dx * sd * L / 4, 0, mz + dz * sd * L / 4); pg.rotation.y = rot;
          const pane = new THREE.Mesh(new THREE.BoxGeometry(pw, hh, .02), glassMat);
          pane.position.y = dB + hh / 2; pg.add(pane);
          const trim = (w, h, ox, oy) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, .05), frameMat);
            m.position.set(dx * ox, dB + hh / 2 + oy, dz * ox); m.castShadow = true; pg.add(m);
          };
          trim(.05, hh, -pw / 2 + .025, 0); trim(.05, hh, pw / 2 - .025, 0);
          trim(pw - .05, .05, 0, hh / 2 - .025); trim(pw - .05, .05, 0, -hh / 2 + .025);
          pg.traverse(c => c.userData.door = adoor);          // 门扇可点：手动开合兜底（自动感应仍生效）
          adoor.pivots.push({ g: pg, px: pg.position.x, pz: pg.position.z, ax: dx * sd, az: dz * sd, dist: L / 2 + .02, pw });
          archUp.add(pg);
        });
        doors.push(adoor);
        const housing = new THREE.Mesh(new THREE.BoxGeometry(L + .1, .12, TT * .9), frameMat);   // 门机箱
        housing.position.set(mx, dT - .06, mz); housing.rotation.y = rot; housing.castShadow = true; archUp.add(housing);
        const sensor = new THREE.Mesh(new THREE.BoxGeometry(.24, .05, .1), mat('#4a4a48', { roughness: .5 }));   // 感应器
        sensor.position.set(mx, dT - .14, mz); sensor.rotation.y = rot; archUp.add(sensor);
        return;                                               // 感应门不设碰撞：关闭/开启都可穿行，门扇动画只作视觉表现
      }
      if (o.kind === 'revolve') {                             // 旋转门：圆筒玻璃 + 三翼旋翼 + 上下环梁
        const hh = Math.max(.8, dT - dB), L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1);
        const r = Math.max(.4, L / 2), TT = M(T);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);          // 门顶过梁
        const wdx = wx(P1[0]) - wx(P0[0]), wdz = wz(P1[1]) - wz(P0[1]);   // 沿墙方向；法向即人穿门洞的进出方向
        const gateA = Math.atan2(-wdz, wdx), halfGate = 40 * Math.PI / 180, arcLen = Math.PI - 2 * halfGate;   // 两个对置出入口各留 80° 口
        [[gateA + halfGate, arcLen], [gateA + Math.PI + halfGate, arcLen]].forEach(([ts, tl]) => {   // ts=起始角, tl=弧长；此前误把结束角当弧长传入，导致两段弧重叠、两根端点柱叠在同一处成「两条竖杆」
          const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh, Math.max(4, Math.round(36 * tl / (Math.PI * 2))), 1, true, ts, tl), glassMat);
          cyl.position.set(mx, dB + hh / 2, mz); archUp.add(cyl);        // 外围玻璃两段弧，出入口断开；弧身离散碰撞挡人，只能从开口进出
          [ts, ts + tl].forEach(th => {                                  // 每个断口端点加竖向边框柱（两个出入口共 4 根），包住玻璃弧边缘
            const jamb = new THREE.Mesh(new THREE.BoxGeometry(.06, hh, .06), frameMat);
            jamb.position.set(mx + Math.sin(th) * r, dB + hh / 2, mz + Math.cos(th) * r);
            jamb.rotation.y = th; jamb.castShadow = true; archUp.add(jamb);
          });
          const segN = Math.max(3, Math.ceil(tl * r / .15));             // 玻璃弧离散成短线段加入带高度碰撞：玻璃挡人，只有断开的出入口能过
          for (let s = 0; s < segN; s++) {
            const a0 = ts + tl * s / segN, a1 = ts + tl * (s + 1) / segN;
            addBarrier(mx + Math.sin(a0) * r, mz + Math.cos(a0) * r, mx + Math.sin(a1) * r, mz + Math.cos(a1) * r, dB, dT, .2);
          }
        });
        [dB + .03, dB + hh - .03].forEach(y => {              // 上下环梁
          const ring = new THREE.Mesh(new THREE.TorusGeometry(r, .035, 10, 44), frameMat);
          ring.rotation.x = Math.PI / 2; ring.position.set(mx, y, mz); ring.castShadow = true; archUp.add(ring);
        });
        const wingMat = oneMat(glassMat.clone());
        const spin = new THREE.Group();                        // 三翼统一挂一个父组，父组绕中心轴持续旋转（主循环里驱动）
        spin.position.set(mx, dB + hh / 2, mz); spin.rotation.y = rot; archUp.add(spin);
        for (let k = 0; k < 3; k++) {                          // 三翼旋翼：相对父组均布 120°
          const grpW = new THREE.Group(); grpW.rotation.y = k * Math.PI * 2 / 3; spin.add(grpW);
          const wing = new THREE.Mesh(new THREE.BoxGeometry(r * .94, hh - .1, .02), wingMat);
          wing.position.x = r * .47; grpW.add(wing);
          const post = new THREE.Mesh(new THREE.BoxGeometry(.04, hh, .04), frameMat);
          post.position.x = r * .94; grpW.add(post);          // 翼末端立柱：随翼一起转，与静止的外壳断口柱不是一回事
        }
        revolveSpins.push(spin);
        revolveHit.push({ spin, mx, mz, r: r * .94, y0: dB, y1: dT });   // 三翼随动碰撞：端点是中心的径向线段，角度每帧从 spin.rotation.y 实时取
        colliders.push([mx - .06, mz - .06, mx + .06, mz + .06]);        // 中心实心轴：静态碰撞，任何高度都挡（玩家不会钻进轴心）
        const core = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, hh, 12), frameMat);
        core.position.set(mx, dB + hh / 2, mz); archUp.add(core);
        return;
      }
      if (o.kind === 'roller') {                             // 卷帘门：顶部卷帘箱 + 帘片，点击卷起 / 放下（开启后可穿行）
        const hh = Math.max(.3, Math.min(dT - dB, top - dB));           // 帘片高度 = 门高（门槛以上到门洞顶）
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);                     // 门槛下的矮墙
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);                    // 门洞上方过梁
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const housing = new THREE.Mesh(new THREE.BoxGeometry(L, .2, TT * .96), frameMat);   // 卷帘箱（挂洞口顶部，略薄于墙厚）
        housing.position.set(mx, dT - .1, mz); housing.rotation.y = rot; housing.castShadow = true; archUp.add(housing);
        const slatMat = mat('#c2c8cc', { roughness: .45, metalness: .35 });
        const nS = Math.max(3, Math.round(hh / .12));
        const slatGrp = new THREE.Group(); slatGrp.position.set(mx, dT, mz); slatGrp.rotation.y = rot; archUp.add(slatGrp);   // 组挂在洞顶：scale.y 收缩即向上卷
        for (let k = 0; k < nS; k++) {
          const sl = new THREE.Mesh(new THREE.BoxGeometry(L, hh / nS - .015, .05), slatMat);
          sl.position.set(0, -(k + .5) * hh / nS, 0); sl.castShadow = true; slatGrp.add(sl);
        }
        const door = {
          slat: true, grp: slatGrp, open: false, cur: 1, a1: 0, a0: 1,       // cur 1=放下 0=卷起
          mx: wx((P0[0] + P1[0]) / 2), mz: wz((P0[1] + P1[1]) / 2), ax: wx(P1[0]) - wx(P0[0]), az: wz(P1[1]) - wz(P0[1])
        };
        housing.userData.door = door;
        slatGrp.children.forEach(sl => sl.userData.door = door);
        doors.push(door);
        return;
      }
      if (o.kind === 'elev') {                               // 电梯门：金属中分双扇，开合只由门侧呼叫面板驱动
        const hh = dT - dB;
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB, false);   // 门槛下的矮墙：顶面朝上会被看到，用墙色而不是剖面深色（否则门洞下方像一块黑板）
        if (dB > .06) {
          sills.push({ x0: P0[0], z0: P0[1], x1: P1[0], z1: P1[1], T, y: dB });   // 抬高门槛登记为可踩踏台面，漫游自动迈上去
          barriers.push([wx(P0[0]), wz(P0[1]), wx(P1[0]), wz(P1[1]), 0, dB - .01, T / 2000 + .1]);   // 门槛下墙段按高度挡人：站上门槛（脚高 = dB）后不再挡，走出去自然落下
        }
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);         // 门洞上方过梁
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;   // 沿墙单位方向（世界系）
        const pm = mat('#c6ccd1', { roughness: .4, metalness: .5 });
        const edoor = { slide: true, lift: true, liftId: o.liftId ?? null, liftSource: 'hall', oid: o.id, liftFloor: o.liftFloor ?? 0, open: false, cur: 0, pivots: [], gx: mx, gz: mz, y0: dB, y1: dT, ex: dx, ez: dz, nx: -dz, nz: dx, half: L / 2, base: dB, top: dT };   // 层门对象：不挂点击标记，联动到站时按所在楼层索引开合；ex/ez、nx/nz、half 供自动关门的光幕判定
        [-1, 1].forEach(sd => {                              // 两扇：闭合时从中缝到各自洞口端，开启时滑向墙内
          const pw = L / 2 - .003, thk = Math.max(.04, TT - .02), pg = new THREE.Group();   // 门扇宽顶到门套立梃内缘（留 3mm 缝），厚取墙厚 - 20mm 与门套齐平
          pg.position.set(mx + dx * sd * L / 4, 0, mz + dz * sd * L / 4); pg.rotation.y = rot;
          const panel = new THREE.Mesh(new THREE.BoxGeometry(pw, hh, thk), pm);
          panel.position.y = dB + hh / 2;                      // 扇板底边贴门槛、顶到门洞高（组原点在 ±L/4 的地面处）
          panel.castShadow = true; pg.add(panel);
          const seam = new THREE.Mesh(new THREE.BoxGeometry(.02, hh, thk + .008), frameMat);   // 扇面中缝饰条
          seam.position.x = -sd * pw / 2; panel.add(seam);
          edoor.pivots.push({ g: pg, px: pg.position.x, pz: pg.position.z, ax: dx * sd, az: dz * sd, dist: L / 2, pw });
          archUp.add(pg);
        });
        doors.push(edoor);
        // 层门门套：上横梁 + 左右立梃（地面一侧不加底边，门槛槽留空），门扇前后比门套内凹 2mm，看起来是齐平的金属包边
        if (top > dT + .02) {                                  // 横梁压在洞顶之上（门扇全高可见）；门洞到墙顶时没有上边框
          const head = new THREE.Mesh(new THREE.BoxGeometry(L + .12, .1, TT * 1.02), frameMat);
          head.position.set(mx, dT + .05, mz); head.rotation.y = rot; head.castShadow = head.receiveShadow = true; archUp.add(head);
        }
        [-1, 1].forEach(sd => {                                 // 两侧立梃：贴门洞两端、包住墙厚，不落到地面以下
          const jamb = new THREE.Mesh(new THREE.BoxGeometry(.06, hh, TT * 1.04), frameMat);
          jamb.position.set(mx + dx * sd * (L / 2 + .03), dB + hh / 2, mz + dz * sd * (L / 2 + .03));
          jamb.rotation.y = rot; jamb.castShadow = jamb.receiveShadow = true; archUp.add(jamb);
        });
        const sill = new THREE.Mesh(new THREE.BoxGeometry(L + .06, .02, TT), mat('#b9c0c6', { metalness: .6, roughness: .35 }));   // 金属门槛板：抬高门槛时跟着门槛走，盖住门槛下矮墙的顶面
        sill.position.set(mx, dB + .01, mz); sill.rotation.y = rot; sill.receiveShadow = true; archUp.add(sill);
        const linked = (state.lifts || []).find(x => x.id === o.liftId);
        const hc = hallCallPanel(linked, o.liftFloor ?? 0, o.id);
        if (linked) regLiftDisp(linked.id, hc);                                     // 门洞显示屏跟随联动电梯：运行跳层时同步刷新
        const hcW = .16, hcY = dB + Math.min(1.15, Math.max(.4, hh - hc.ph - .06));
        const bs = o.btn === 'l' ? -1 : 1;                    // 呼叫面板装在门的左侧还是右侧
        const bx = mx + dx * bs * (L / 2 + .16), bz = mz + dz * bs * (L / 2 + .16);
        [[dz, -dx, -1], [-dz, dx, 1]].forEach(([nx, nz, s]) => {   // 两侧墙面各装一块，哪边都能呼叫；s=1 面朝局部 +Z
          const fx = bx + nx * (TT / 2 + .011), fz = bz + nz * (TT / 2 + .011), faceRot = s > 0 ? rot : rot + Math.PI;
          const bg = new THREE.Mesh(new THREE.BoxGeometry(hcW + .02, hc.ph + .02, .022), frameMat);
          bg.position.set(fx, hcY + hc.ph / 2, fz); bg.rotation.y = faceRot; bg.castShadow = true; archUp.add(bg);
          const face = new THREE.Mesh(new THREE.PlaneGeometry(hcW, hc.ph), new THREE.MeshBasicMaterial({ map: hc.tex, toneMapped: false }));
          face.position.set(fx + nx * .012, hcY + hc.ph / 2, fz + nz * .012); face.rotation.y = faceRot; archUp.add(face);
          hc.hits.forEach(h => {                              // 透明命中盒：纹理左右沿墙面偏移（s=-1 那面镜像）
            const hit = new THREE.Mesh(new THREE.BoxGeometry(.05, .05, .02), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
            hit.position.set(fx - s * dx * h.z + nx * .03, hcY + h.y, fz - s * dz * h.z + nz * .03);
            hit.userData.liftBtn = { id: linked ? linked.id : null, act: 'hall', floor: h.floor, doorId: o.id };
            archUp.add(hit);
          });
        });
        return;
      }
      if (o.kind === 'fwin') {                               // 落地窗：通顶玻璃 + 田字格（外框 + 中竖 + 中横，分四格）
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1);
        const pane = new THREE.Mesh(new THREE.BoxGeometry(L, top, .01), glassMat);
        pane.position.set(mx, top / 2, mz); pane.rotation.y = rot; archUp.add(pane);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        [-L / 2 + .025, 0, L / 2 - .025].forEach(off => {    // 左右端竖梃 + 中竖
          const mu = new THREE.Mesh(new THREE.BoxGeometry(.06, top, .06), frameMat);
          mu.position.set(mx + dx * off, top / 2, mz + dz * off); mu.castShadow = true; archUp.add(mu);
        });
        [.03, top / 2, top - .03].forEach(y => {             // 下 / 中 / 上横梃 → 田字
          const bar = new THREE.Mesh(new THREE.BoxGeometry(L, .06, .06), frameMat);
          bar.position.set(mx, y, mz); bar.rotation.y = rot; bar.castShadow = true; archUp.add(bar);
        });
        if (o.cg) {                                          // 转角窗：转角只补一根与窗梃同款的 60×60 立柱（不按墙厚填玻璃，避免转角出现大块玻璃柱）
          const atStart = c0 <= 400, atEnd = c1 >= WL - 400;  // 贴转角判定统一 400mm（与 2D 延伸 / lbCornerAt 同一阈值）；两段都贴转角时只补一次：由贴在墙端的那段负责
          let addPost = atEnd;
          if (atStart && !atEnd) {
            const mate = state.openings.find(p => p.cg === o.cg && p.id !== o.id);
            const mg = mate && openingWallGeom(mate.wall);
            const cp = A;
            if (!mg) addPost = true;
            else {
              const mwl = Math.hypot(mg.B[0] - mg.A[0], mg.B[1] - mg.A[1]) || 1;
              const mateAt = (Math.hypot(mg.A[0] - cp[0], mg.A[1] - cp[1]) <= 400 && mate.c <= 400) ||
                (Math.hypot(mg.B[0] - cp[0], mg.B[1] - cp[1]) <= 400 && mate.c + mate.w >= mwl - 400);
              addPost = !mateAt;
            }
          }
          if (addPost) {
            const cp = atEnd ? B : A;
            const post = new THREE.Mesh(new THREE.BoxGeometry(.06, top, .06), frameMat);
            post.position.set(wx(cp[0]), top / 2, wz(cp[1])); post.castShadow = true; archUp.add(post);
          }
        }
        pushWallCollider(P0, P1, T, top);
        return;
      }
      if (o.kind === 'slid') {                               // 推拉门：玻璃双扇，点哪扇开哪扇（沿轨道滑向对面叠上）
        const hh = dT - dB;
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);          // 门槛下的墙
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);         // 门洞上方过梁
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        const sg = oneMat(glassMat.clone());                         // 克隆玻璃材质：pick() 跳过原始 glassMat，克隆体才能点击开合
        [-1, 1].forEach(sd => {
          const pw = L / 2 - .01, pg = new THREE.Group();
          const tnx = dz * sd * TT * .09, tnz = -dx * sd * TT * .09;   // 双轨道：两扇沿墙厚各偏一侧，交错滑行不打架
          pg.position.set(mx + dx * sd * L / 4 + tnx, 0, mz + dz * sd * L / 4 + tnz); pg.rotation.y = rot;
          const panel = new THREE.Mesh(new THREE.BoxGeometry(pw, hh, TT * .12), sg);
          panel.position.y = dB + hh / 2; pg.add(panel);
          const pdoor = { slide: true, open: false, cur: 0, pivots: [{ g: pg, px: pg.position.x, pz: pg.position.z, ax: -dx * sd, az: -dz * sd, dist: L / 2 - .02, pw }] };   // 点哪扇开哪扇：该扇滑向对面、叠在另一扇上
          panel.userData.door = pg.userData.door = pdoor;
          const trim = (w, h, ox, oy) => {                     // 扇框：四周边梃 + 上下横梃
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, TT * .16), frameMat);
            m.position.x = ox; m.position.y = oy; m.castShadow = true; m.userData.door = pdoor; panel.add(m);
          };
          trim(.06, hh, -(pw / 2 - .03), 0); trim(.06, hh, pw / 2 - .03, 0);          // 左右竖梃（含中缝侧）
          trim(pw - .06, .06, 0, hh / 2 - .03); trim(pw - .06, .06, 0, -(hh / 2 - .03));   // 上下横梃
          doors.push(pdoor);
          archUp.add(pg);
        });
        [dT - .03, dB + .03].forEach(y => {                  // 门套横梁 / 地槛
          const tr = new THREE.Mesh(new THREE.BoxGeometry(L + .1, .06, TT * 1.02), frameMat);
          tr.position.set(mx, y, mz); tr.rotation.y = rot; archUp.add(tr);
        });
        return;
      }
      if (o.kind === 'sd') {                                 // 单扇推拉门：一扇玻璃门走在墙体外侧轨道，点门扇滑开
        const hh = dT - dB;
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        const side = o.flip ? -1 : 1, dir = o.dir === -1 ? -1 : 1;   // side：贴墙哪一侧（翻转）；dir：向墙哪一端滑开（开门方向）
        const off = side * (TT / 2 + .035);                   // 门扇贴墙外侧走，滑开时不穿墙；翻转后贴另一侧
        const sg = oneMat(glassMat.clone()), pg = new THREE.Group();
        pg.position.set(mx + dz * off, 0, mz - dx * off); pg.rotation.y = rot;
        const lap = .04, pw = L + lap * 2, slideDist = L + lap * 2;   // 门扇比洞口宽（每边搭接 40mm）关闭时遮严；滑开距离≈门扇宽，开启后完全露出洞口
        const pane = new THREE.Mesh(new THREE.BoxGeometry(pw, hh, .02), sg);
        pane.position.y = dB + hh / 2; pg.add(pane);
        const pdoor = { slide: true, open: false, cur: 0, pivots: [{ g: pg, px: pg.position.x, pz: pg.position.z, ax: -dx * dir, az: -dz * dir, dist: slideDist, pw }] };
        pane.userData.door = pg.userData.door = pdoor;
        const trim = (w, h, ox, oy) => {                     // 扇框：左右竖梃 + 上下横梃
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, .05), frameMat);
          m.position.set(ox, oy, 0); m.castShadow = true; m.userData.door = pdoor; pg.add(m);
        };
        trim(.06, hh, -(pw / 2 - .03), dB + hh / 2); trim(.06, hh, pw / 2 - .03, dB + hh / 2);
        trim(pw - .06, .06, 0, dB + hh - .03); trim(pw - .06, .06, 0, dB + .03);
        doors.push(pdoor); archUp.add(pg);
        const track = new THREE.Mesh(new THREE.BoxGeometry(pw + slideDist, .05, .07), frameMat);              // 轨道覆盖门扇从关到开的全行程
        const tsh = slideDist / 2;                                                                            // 朝滑开方向偏移，使全长覆盖关闭位与开启位
        track.position.set(mx + dz * off - dx * dir * tsh, dT - .025, mz - dx * off - dz * dir * tsh);
        track.rotation.y = rot; archUp.add(track);
        [dT - .03, dB + .03].forEach(y => {
          const tr = new THREE.Mesh(new THREE.BoxGeometry(L, .05, TT * .55), frameMat);
          tr.position.set(mx, y, mz); tr.rotation.y = rot; archUp.add(tr);
        });
        return;
      }
      if (o.kind === 'fold') {                               // 折叠门：4 扇平开为关门状态，点门扇两两折起在洞口两侧（V 形）
        const hh = dT - dB;
        if (dB > .001) wallSeg3D(P0, P1, T, 0, dB);
        pushSillCollider(P0, P1, T, dB);
        if (top > dT) wallSeg3D(P0, P1, T, dT, top);
        const L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
        const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
        const N = 4, pw = L / N, th = Math.PI / 3, sg = oneMat(glassMat.clone());
        const dir = o.flip ? -1 : 1;                         // 折向房间一侧，避免穿墙
        const wp = (s, z) => [mx + dx * s + dz * z * dir, mz + dz * s - dx * z * dir];
        const makeLeaf = (d, parent) => {                    // 每扇以铰链为原点，向局部 +x 方向伸出
          const pivot = new THREE.Group();
          const pane = new THREE.Mesh(new THREE.BoxGeometry(pw - .03, hh, .016), sg);
          pane.position.set(pw / 2, dB + hh / 2, 0); pane.userData.door = d; pivot.add(pane);
          [.015, pw - .015].forEach(ox => {                  // 左右竖梃
            const m = new THREE.Mesh(new THREE.BoxGeometry(.05, hh, .05), frameMat);
            m.position.set(ox, dB + hh / 2, 0); m.castShadow = true; m.userData.door = d; pivot.add(m);
          });
          [dB + .025, dB + hh - .025].forEach(oy => {        // 上下横梃
            const m = new THREE.Mesh(new THREE.BoxGeometry(pw - .03, .05, .05), frameMat);
            m.position.set(pw / 2, oy, 0); m.castShadow = true; m.userData.door = d; pivot.add(m);
          });
          parent.add(pivot); return pivot;
        };
        // 左、右两半各自成对：关门时并排铺满半个洞口，点击各自折成 V 形，互不影响
        for (const side of [-1, 1]) {
          const s0 = side * L / 2, [bx, bz] = wp(s0, TT / 2);
          const base = new THREE.Group();
          base.position.set(bx, 0, bz); base.rotation.y = rot + (side > 0 ? Math.PI : 0);
          archUp.add(base);
          const sgn = side < 0 ? 1 : -1;                    // 右半的局部 x 轴反向，角度取反才是同样的折向
          const d = { fold: true, open: false, cur: 0, parts: [], mx, mz, ax: dx, az: dz, s0: Math.min(s0, s0 - side * L / 2), s1: Math.max(s0, s0 - side * L / 2) };
          const A = makeLeaf(d, base), B = makeLeaf(d, A);
          B.position.x = pw;
          d.parts.push({ g: A, a: dir * sgn * th }, { g: B, a: -dir * sgn * 2 * th });
          doors.push(d);
        }
        const track = new THREE.Mesh(new THREE.BoxGeometry(L, .05, .07), frameMat);
        track.position.set(mx, dT - .025, mz); track.rotation.y = rot; archUp.add(track);
        [dT - .03, dB + .03].forEach(y => {
          const tr = new THREE.Mesh(new THREE.BoxGeometry(L, .05, TT * .55), frameMat);
          tr.position.set(mx, y, mz); tr.rotation.y = rot; archUp.add(tr);
        });
        return;
      }
      const sill0 = o.sill ?? (o.kind === 'hwin' ? 1400 : 900);           // 窗台高：属性里可调，普通窗默认 900、高窗 1400
      const sill = Math.max(0, Math.min(sill0 / 1000, top - .25));        // 至少给窗留 250 高
      const whM = Math.max(.3, (o.wh ?? Math.round((2.4 - sill) * 1000)) / 1000);   // 窗户总高度（含窗花）：属性可调，缺省窗顶 2.4m
      const head = Math.min(sill + whM, top);                             // 窗顶（含亮子）
      const thM = Math.min(whM, Math.max(.15, (o.th ?? 500) / 1000));     // 窗花高度：不能超过窗户总高度，缺省 500
      const sTop = o.grille === true ? Math.max(sill, head - thM) : head; // 窗扇区顶：勾窗花时上部为亮子
      wallSeg3D(P0, P1, T, 0, Math.min(sill, top));
      if (sTop <= sill) return;
      const gh = sTop - sill, L = M(o.w), rot = wallAngle(P0, P1), [mx, mz] = wallMid(P0, P1), TT = M(T);
      const dx = (wx(P1[0]) - wx(P0[0])) / L, dz = (wz(P1[1]) - wz(P0[1])) / L;
      if (o.grille === true && head - sTop > .02) {          // 窗花：窗扇区上方的横向带框固定玻璃（亮子），下沿与窗扇框共用
        const bh = head - sTop;
        const bpane = new THREE.Mesh(new THREE.BoxGeometry(L, bh, .012), glassMat);
        bpane.position.set(mx, sTop + bh / 2, mz); bpane.rotation.y = rot; archUp.add(bpane);
        [-L / 2 + .025, L / 2 - .025].forEach(off => {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(.05, bh, .06), frameMat);
          bar.position.set(mx + dx * off, sTop + bh / 2, mz + dz * off); bar.rotation.y = rot; archUp.add(bar);
        });
        [sTop + .025, head - .025].forEach(y => {            // 亮子下 / 上横梃（下沿与窗扇框分界）
          const bar = new THREE.Mesh(new THREE.BoxGeometry(L, .05, .06), frameMat);
          bar.position.set(mx, y, mz); bar.rotation.y = rot; archUp.add(bar);
        });
      }
      if (top > head) wallSeg3D(P0, P1, T, head, top);       // 窗顶以上墙段
      const cy = sill + gh / 2, sg = oneMat(glassMat.clone());        // 克隆玻璃材质：pick() 跳过原始 glassMat，克隆体才能点击
      const NP = Math.max(1, Math.min(4, Math.round(+o.panes || 2)));   // 窗扇数：属性可调（默认 2 扇，1–4），偶数序号扇走左轨、奇数走右轨
      for (let i = 0; i < NP; i++) {                          // 点哪扇开哪扇，沿墙滑过相邻扇叠起来
        const sd = i % 2 === 0 ? -1 : 1;
        const pw = L / NP, pg = new THREE.Group();            // 每扇占满 1/N：相邻扇框在中缝相触、外缘与外框齐平，不留缝
        const tnx = dz * sd * TT * .09, tnz = -dx * sd * TT * .09;   // 双轨：相邻扇各偏一侧墙厚，交错滑行不打架
        const ox = L * (i + .5) / NP - L / 2;
        pg.position.set(mx + dx * ox + tnx, 0, mz + dz * ox + tnz); pg.rotation.y = rot;
        const pdoor = {
          slide: true, win: true, open: false, cur: 0,
          pivots: [{ g: pg, px: pg.position.x, pz: pg.position.z, ax: -dx * sd, az: -dz * sd, dist: pw }]
        };
        const pane = new THREE.Mesh(new THREE.BoxGeometry(pw, gh, .012), sg);
        pane.position.y = cy; pane.userData.door = pdoor; pg.add(pane);
        const bar = (w, h, ox2, oy) => {                      // 扇框：左右竖梃 + 上下横梃
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, .045), frameMat);
          m.position.set(ox2, cy + oy, 0); m.castShadow = true; m.userData.door = pdoor; pg.add(m);
        };
        bar(.05, gh, -(pw / 2 - .025), 0); bar(.05, gh, pw / 2 - .025, 0);
        bar(pw - .05, .05, 0, gh / 2 - .025); bar(pw - .05, .05, 0, -(gh / 2 - .025));
        pg.userData.door = pdoor;
        doors.push(pdoor); archUp.add(pg);
      }
      [sill + .02, head - .02].forEach(y => {                 // 外框上下横梃（固定在洞口，不随窗扇滑动）
        const bar = new THREE.Mesh(new THREE.BoxGeometry(L, .05, .06), frameMat);
        bar.position.set(mx, y, mz); bar.rotation.y = rot; archUp.add(bar);
      });
      [-L / 2 + .025, L / 2 - .025].forEach(off => {          // 外框左右竖梃：窗扇滑开后洞口仍有边框
        const bar = new THREE.Mesh(new THREE.BoxGeometry(.05, gh, .06), frameMat);
        bar.position.set(mx + dx * off, cy, mz + dz * off); bar.rotation.y = rot; archUp.add(bar);
      });
      pushWallCollider(P0, P1, T, top);                      // 窗下不能穿行
    }
    // 转角飘窗转角补齐：台板 / 坐板整条按一个 L 形轮廓生成（转角斜接），再补上两段之间缺的两面转角玻璃。
    // 之前的做法是把两段的台板各出一块 + 转角处用世界坐标包围盒补一个方块，转角会外扩 / 压进墙里，上下面都出现台阶。
    function buildLBayCorner3D(o, legs, top) {
      const dep = Math.max(.15, Math.min((o.bayDepth ?? 600) / 1000, 1.5)), depMM = dep * 1000;
      const sill = Math.max(0, Math.min((o.sill ?? 500) / 1000, top - .5));
      const wh = Math.max(.4, Math.min((o.wh ?? 1200) / 1000, top - sill));
      const head = sill + wh;
      const info = legs.map(({ PA, PB, leg }) => {
        const dx = PB[0] - PA[0], dy = PB[1] - PA[1], L = Math.hypot(dx, dy) || 1;
        const u = [dx / L, dy / L], n = [-u[1], u[0]], side = leg.flip ? -1 : 1, ov = [n[0] * side, n[1] * side];
        const Pc = leg.lc === -1 ? PA : PB, far = leg.lc === -1 ? PB : PA;   // Pc 转角端 / far 另一端
        const fl = Math.hypot(far[0] - Pc[0], far[1] - Pc[1]) || L;
        return {
          u, ov, Pc, fl, away: [(far[0] - Pc[0]) / fl, (far[1] - Pc[1]) / fl],
          Qc: [Pc[0] + ov[0] * depMM, Pc[1] + ov[1] * depMM]
        };
      });
      if (info.length < 2) return;
      const meet = (p, u, q, v) => {                         // 两条直线（点 + 方向）的交点
        const cr = u[0] * v[1] - u[1] * v[0];
        if (Math.abs(cr) < 1e-6) return null;
        const t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / cr;
        return isFinite(t) ? [p[0] + u[0] * t, p[1] + u[1] * t] : null;
      };
      const a = info[0], b = info[1];
      const X = meet(a.Qc, a.u, b.Qc, b.u);                  // 两段外沿延长线交点 = 转角外角
      if (!X) return;
      const shift = (g, d) => [g.Pc[0] + g.ov[0] * d, g.Pc[1] + g.ov[1] * d];   // 沿外法向平移后的参考点
      const bandPts = (ein, eout, efar) => {                 // L 形轮廓：内沿缩进 ein、外沿外挑 eout、远端外挑 efar（mm）
        const ai = shift(a, -ein), ao = shift(a, depMM + eout), bi = shift(b, -ein), bo = shift(b, depMM + eout);
        const IC = meet(ai, a.u, bi, b.u), OC = meet(ao, a.u, bo, b.u);         // 转角内角 / 外角都按两条边线求交，斜接
        if (!IC || !OC) return null;
        const endPt = (g, d) => [g.Pc[0] + g.away[0] * (g.fl + efar) + g.ov[0] * d, g.Pc[1] + g.away[1] * (g.fl + efar) + g.ov[1] * d];
        return [endPt(a, -ein), endPt(a, depMM + eout), OC, endPt(b, depMM + eout), endPt(b, -ein), IC];
      };
      const band = (pts, y, th, m) => {                      // 把轮廓挤出成一块整板（上下两块台板 / 坐板共用）
        if (!pts) return;
        const geo = new THREE.ExtrudeGeometry(shapeOf(pts), { depth: th, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, m);
        mesh.position.y = y; mesh.castShadow = mesh.receiveShadow = true; archUp.add(mesh);
      };
      const dripMM = BAY_DRIP * 1000;                        // 与单段飘窗一致的外挑尺寸
      band(bandPts(15, dripMM, 30), sill - .06, .06, frameMat);   // 下窗台板（与两段同一标高、同一外沿，整条不断缝）
      band(bandPts(15, dripMM, 30), head, .06, frameMat);         // 上盖板：与窗台板同样挑出，上下齐平挡雨
      band(bandPts(0, 0, 0), sill, .04, mat('#e9e2d4', { roughness: .9 }));   // 窗台坐板：与玻璃内表面齐平
      [[X, a.Qc, a.ov], [X, b.Qc, b.ov]].forEach(([p, q, ov]) => {   // 转角两面玻璃也做成可开扇：铰在转角立柱上、向外推开
        addBaySash([wx(p[0]), wz(p[1])], [wx(q[0]), wz(q[1])], sill, wh, ov[0], ov[1]);
      });
      const post = new THREE.Mesh(new THREE.BoxGeometry(.06, wh, .06), frameMat);   // 转角外角竖梃
      post.position.set(wx(X[0]), sill + wh / 2, wz(X[1])); post.castShadow = true; archUp.add(post);
    }
    function shapeOf(poly, flip) { const s = new THREE.Shape(); poly.forEach(([x, y], i) => s[i ? 'lineTo' : 'moveTo'](wx(x), flip ? wz(y) : -wz(y))); return s; }
    function clipPolyToRect(poly, x0, z0, x1, z1) {               // 世界米 [x,z] 多边形按矩形裁剪（Sutherland–Hodgman；矩形是凸的，对凹房间多边形同样适用）
      const cut = (pts, inside, inter) => {
        if (!pts.length) return pts;
        const out = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length], ia = inside(a), ib = inside(b);
          if (ia) out.push(a);
          if (ia !== ib) out.push(inter(a, b));
        }
        return out;
      };
      const ix = (a, b, X) => { const t = (X - a[0]) / ((b[0] - a[0]) || 1e-9); return [X, a[1] + (b[1] - a[1]) * t]; };
      const iz = (a, b, Z) => { const t = (Z - a[1]) / ((b[1] - a[1]) || 1e-9); return [a[0] + (b[0] - a[0]) * t, Z]; };
      let p = poly;
      p = cut(p, q => q[0] >= x0, (a, b) => ix(a, b, x0));
      p = cut(p, q => q[0] <= x1, (a, b) => ix(a, b, x1));
      p = cut(p, q => q[1] >= z0, (a, b) => iz(a, b, z0));
      p = cut(p, q => q[1] <= z1, (a, b) => iz(a, b, z1));
      return p;
    }
    function holePathsFor(polyMM) {                               // 平面 mm 房间多边形 → 与本层每个洞口矩形求交（世界米点列），供房间地面 / 天花挖洞
      const pw = polyMM.map(([x, y]) => [wx(x), wz(y)]);
      let roomArea = 0;
      for (let i = 0; i < pw.length; i++) { const a = pw[i], b = pw[(i + 1) % pw.length]; roomArea += a[0] * b[1] - b[0] * a[1]; }
      roomArea = Math.abs(roomArea) / 2;
      const out = [], inset = .012;                               // 洞边内缩 12mm：避免 hole 与房间外轮廓共边，Earcut 三角化更稳
      fpHoles().forEach(h => {
        const raw = clipPolyToRect(pw, h[0] + inset, h[1] + inset, h[2] - inset, h[3] - inset);
        const pts = [];
        raw.forEach(q => { const l = pts[pts.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-4) pts.push(q); });
        if (pts.length > 1) { const f = pts[0], l = pts[pts.length - 1]; if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-4) pts.pop(); }
        if (pts.length < 3) return;
        let area = 0;
        for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
        area = Math.abs(area) / 2;
        if (area < .01) return;                                   // 小于 0.01m² 的碎片忽略
        if (roomArea > .02 && area >= roomArea * .98) return;     // 洞口几乎盖满整个房间：不挖，避免 hole 与外轮廓重合破面
        out.push(pts);
      });
      return out;
    }

    function buildArch() {
      window.clearDoorHover?.();                                   // 门被重建后悬停高亮引用已失效，立即清除
      selHelpers.forEach(h => { scene.remove(h); h.geometry.dispose(); }); selHelpers = []; selKey = null;
      clearGroup(archFloor); clearGroup(archUp); lampG.clear(); doors.length = 0; gateArms.length = 0; parkAnims.length = 0; parkLamps.clear(); stackCells.clear(); stackOps.length = 0; sanVisuals.clear(); wtVisuals.clear(); wtRuns.length = 0; washVisuals.clear(); colliders = []; barriers = []; sills = []; revolveSpins = []; revolveHit = []; escSteps = []; lampGlowMats.length = 0; liftRides.clear(); liftDisp.clear();   // washRuns 保留：洗车流程跨重建续播，其余碰撞 / 动画登记必须随重建清空，否则其它楼层的碰撞会串到当前层挡人
      survRigs.forEach(r => r.rt && r.rt.dispose()); survRigs = []; survScreens = []; survScreenMeshes = []; survTexs.forEach(t => t.dispose()); survTexs = [];   // 安防监控：释放上一轮离屏渲染目标 / 屏幕纹理
      const top = opt.cut;
      allRooms().forEach(r => {
        const styled = !!state.rooms[r.id];                        // 房间是否选过地面材料（有样式）
        const st = state.rooms[r.id] || (stackDefaultFloors ? { mat: 'tile800' } : null);
        if (!st) return;                                           // 空方案：3D 里也不生成房间地面
        const m = floorMat(st.mat), bay = r.counted === false;
        // 整栋模式下无样式房间完全不补（地面 + 天花都不生成）：roomsExtra 几何可能与 rooms 样式 id 失配（旧版楼层复制
        // 只重生成几何 id、样式键留在源层），区域多边形又可能大于本层墙 outline，补出的板会从楼层侧面 / 顶面露出多余薄板。
        // 有样式的房间照常生成；阳台（counted=false）即使无样式也照常生成，避免整栋视图里阳台消失。
        const gen = styled || bay || !stackDefaultFloors;
        if (gen) {
          let geo;
          if (bay) geo = new THREE.ExtrudeGeometry(shapeOf(r.poly), { depth: .45, bevelEnabled: false });
          else {                                                   // 房间地板：楼梯间 / 电梯井 / 楼板洞口挖穿；洞口跨房间边界时按房间轮廓裁剪，各房间合起来开穿
            const sh = shapeOf(r.poly);
            holePathsFor(r.poly).forEach(pts => {
              const p = new THREE.Path();
              pts.forEach(([X, Z], i) => p[i ? 'lineTo' : 'moveTo'](X, -Z));
              sh.holes.push(p);
            });
            geo = new THREE.ShapeGeometry(sh);
          }
          geo.rotateX(-Math.PI / 2);
          const fl = new THREE.Mesh(geo, bay ? [m, mat('#e9e4da')] : m);
          fl.receiveShadow = true; fl.userData.room = r.id;
          fl.visible = opt.slabs !== false;                        // 楼板开关：房间地面跟随隐藏（洞口 / 俯视层间）
          if (bay) { fl.castShadow = true; archUp.add(fl); } else archFloor.add(fl);
        }
        // 天花：法线朝下，只在室内仰视时可见；高度跟着该房间的墙高（面板里可单独设）
        // 楼梯间 / 勾了「无天花」的房间不做天花，也不挂吊灯（保留通高）；整栋模式无样式房间同样不补天花
        const noCeil = roomNoCeil(r), ch = roomCeilMM(r) / 1000;
        if (!noCeil && gen) {
          const csh = shapeOf(r.poly, true);
          holePathsFor(r.poly).forEach(pts => {                  // 天花同样跟随洞口挖穿：否则楼梯间 / 电梯井 / 板洞被实心天花盖平，从上往下看像楼板没镂空
            const p = new THREE.Path();
            pts.forEach(([X, Z], i) => p[i ? 'lineTo' : 'moveTo'](X, Z));
            csh.holes.push(p);
          });
          const cg = new THREE.ShapeGeometry(csh); cg.rotateX(Math.PI / 2);
          const ceil = new THREE.Mesh(cg, mat('#fbfaf7', { roughness: 1 })); ceil.position.y = ch; ceil.visible = top >= H;
          ceil.userData.ceil = true; archUp.add(ceil);
        }
        if (r.at && !noCeil && gen) {
          const lamp = new THREE.Mesh(new THREE.CylinderGeometry(.22, .22, .02, 32), new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#fff2d6', emissiveIntensity: .3 }));
          lamp.position.set(wx(r.at[0]), ch - .012, wz(r.at[1])); lamp.visible = top >= H; lampG.add(lamp);
          const pl = new THREE.PointLight(0xffd9a8, 0, 7, 1.6); pl.position.set(wx(r.at[0]), ch - .25, wz(r.at[1])); lampG.add(pl);
        }
      });
      [...DOORS.map((d, i) => ['d' + i]), ...SLIDES.map((s, i) => ['s' + i])].filter(([id]) => !bopenRemoved(id) && !bopenOnDeadWall(id)).forEach(([id]) => { const r = bopenRect(id); const [x0, y0, x1, y1] = r; const s = box(M(x1 - x0), .012, M(y1 - y0), mat('#d8d0c0', { roughness: .3 }), wx((x0 + x1) / 2), 0, wz((y0 + y1) / 2)); s.castShadow = false; archFloor.add(s); });
      const wallTop = (id, def) => {                           // 墙高（米）：单独设过就按设定值画，只有「剖切墙」模式才切到剖切高度
        const v = +((state.wallH || {})[id]);
        if (!(Number.isFinite(v) && v > 0)) return def;
        return Math.min(opt.cut < H ? opt.cut : Infinity, v / 1000);
      };
      const lbCornerAt = (ref, end) => {                       // 该墙这一端是不是 转角飘窗 / 转角窗的转角端
        const ends = wallEnds(ref), WL = ends ? Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) : 0;
        for (const o of state.openings) {
          if (o.kind === 'lbay' && o.legs) {
            for (const l of o.legs) if (l.wall === ref && l.lc === (end ? 1 : -1)) return o;
          } else if (o.kind === 'fwin' && o.cg && o.wall === ref) {   // 转角窗：窗段贴到墙角时同样按转角处理
            if (end ? o.c + o.w >= WL - 400 : o.c <= 400) return o;
          }
        }
        return null;
      };
      const cornerStub3D = (P0, P1, T, ht, o) => {             // 转角处残留的小墙垛：窗洞高度范围内不砌，否则转角看起来像一根柱子
        if (o.kind === 'fwin') return;                         // 转角窗：落地玻璃通高，转角不留墙垛
        const sill = Math.max(0, Math.min((o.sill ?? 500) / 1000, ht - .5));
        const head = sill + Math.max(.4, Math.min((o.wh ?? 1200) / 1000, ht - sill));
        if (sill > .001) wallSeg3D(P0, P1, T, 0, sill);
        if (ht > head) wallSeg3D(P0, P1, T, head, ht);
      };
      WALLS.forEach((w, i) => {
        const id = 'w' + i;
        pickWallId = id;                                         // 本面墙及门洞墙段归属这个 id，3D 可直接点选
        if (state.deletedWalls.includes(id) || state.demolished.includes(id)) return;
        const s = builtinSeg(i), os = openingsOf(id), cuts = wallCuts(id, s.L), ht = wallTop(id, wallTypeOf(i) === 'low' ? Math.min(1, top) : top);
        if (!cuts.length) {
          wallBox(w, 0, ht);
          colliders.push([wx(w[0]), wz(w[1]), wx(w[2]), wz(w[3]), 0, ht]);
          return;
        }
        wallSegs(id, s.L).forEach(([c0, c1]) => {
          const [P0, P1] = segPts(s.A, s.B, c0, c1);
          const lbo = c1 - c0 <= 400 && ((c1 >= s.L - 1 && lbCornerAt(id, 1)) || (c0 <= 1 && lbCornerAt(id, 0)));
          if (lbo) cornerStub3D(P0, P1, s.T, ht, lbo);
          else wallSegHoles3D(P0, P1, s.T, ht, boxHolesOf(id, ht).map(h => ({ c0: h.c0 - c0, c1: h.c1 - c0, yb: h.yb, yt: h.yt })).filter(h => h.c1 > 0 && h.c0 < c1 - c0));
          pushWallCollider(P0, P1, s.T, ht);
        });
        os.forEach(o => { const s0 = archUp.children.length; buildOpening3D(s.A, s.B, o, ht, s.T); markNew(s0, 'open', o.id); });   // 自画门窗：点击可开合并选中
      });
      // 自己画的墙（含斜墙）：统一用带角度的墙段盒
      state.walls.forEach(w => {
        const id = 'CW' + w.id;
        pickWallId = id;
        if (state.deletedWalls.includes(id) || state.demolished.includes(id)) return;
        const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
        const segs = wallSegs(id, L);
        const e0 = segs.length && segs[0][0] === 0 ? wallEndExt(w, 0) : 0;                    // 与 2D 一致：墙角外扩补全
        const e1 = segs.length && segs[segs.length - 1][1] === L ? wallEndExt(w, 1) : 0;
        const k0 = cwType(w);
        const dflt = (k0 === 'g' || k0 === 'lg') ? (k0 === 'lg' ? Math.min(1.2, top) : top) : k0 === 'low' ? Math.min(1, top) : top;
        const ht = wallTop(id, dflt);                        // 墙高：自定义值优先，否则按类型默认（矮墙 1m、玻璃矮隔断 1.2m、其余通顶）
        segs.forEach(([c0, c1]) => {
          const c0x = c0 > 0 ? c0 : -e0, c1x = c1 < L ? c1 : L + e1;
          const [P0, P1] = segPts(w.a, w.b, c0x, c1x), k = cwType(w);
          const lbo = c1 - c0 <= 400 && ((c1 >= L - 1 && lbCornerAt(id, 1)) || (c0 <= 1 && lbCornerAt(id, 0)));
          if (k === 'g' || k === 'lg') {                     // 玻璃隔断 / 玻璃矮隔断
            const s0 = archUp.children.length; buildGlassWall(P0, P1, cwT(w), ht); markNew(s0, 'wall', id);
          } else if (lbo) {                                  // 转角飘窗转角的小墙垛：窗洞范围内留空
            cornerStub3D(P0, P1, cwT(w), ht, lbo);
          } else {
            wallSegHoles3D(P0, P1, cwT(w), ht, boxHolesOf(id, ht).map(h => ({ c0: h.c0 - c0, c1: h.c1 - c0, yb: h.yb, yt: h.yt })).filter(h => h.c1 > 0 && h.c0 < c1 - c0));
          }
          pushWallCollider(P0, P1, cwT(w), ht);
        });
        openingsOf(id).forEach(o => { const s0 = archUp.children.length; buildOpening3D(w.a, w.b, o, ht, cwT(w)); markNew(s0, 'open', o.id); });
      });
      // 弧形墙：按折线分段生成墙体与碰撞体
      (state.arcWalls || []).forEach(w => {
        const id = 'AW' + w.id;
        pickWallId = id; pickWallKind = 'arcwall';
        if (state.deletedWalls.includes(id) || state.demolished.includes(id)) return;
        const pts = arcSamples(w.a, w.b, +w.bulge || 0, 24), th = Math.max(60, +w.t || 240);
        const ht = Math.min(top, Math.max(.6, (+w.h || currentFloorH()) / 1000));
        for (let i = 0; i < pts.length - 1; i++) {
          wallSeg3D(pts[i], pts[i + 1], th, 0, ht);
          pushWallCollider(pts[i], pts[i + 1], th, ht);
        }
      });
      pickWallId = null; pickWallKind = 'wall';                // 后续洞口过梁等不属于任何可选墙
      /* ---------- 屋顶 / 廊架 / 露台 / 泳池（室外配套） ---------- */
      const roofMat = mat('#8a6a58', { roughness: .85 }), outWood = mat('#8d7355', { roughness: .8 });
      (state.roofs || []).forEach(r => {
        const s0 = archUp.children.length;
        const oh = M(Math.max(0, +r.overhang || 0)), hz = M(r.hz ?? 2800), rise = M(r.rise ?? 1200);
        const x0 = wx(r.x - r.w / 2) - oh, x1 = wx(r.x + r.w / 2) + oh;
        const z0 = wz(r.y - r.d / 2) - oh, z1 = wz(r.y + r.d / 2) + oh;
        const xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
        // 屋脊方向与 2D 一致：永远沿 X（水平），坡向沿 Z（进深）
        const addPlane = (len, slope, ang, px, py, pz, rotAxis) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(rotAxis === 'z' ? slope : len, .14, rotAxis === 'z' ? len : slope), roofMat);
          b.position.set(px, py, pz); b.rotation[rotAxis] = ang; b.castShadow = b.receiveShadow = true; archUp.add(b);
        };
        if (r.type === 'shed') {                                   // 单坡：屋脊在靠上 1/4 处（与 2D 一致），坡向另一侧下倾
          const zRidge = z0 + (z1 - z0) * .25, D = z1 - zRidge, ang = Math.atan2(rise, D);
          addPlane(x1 - x0, Math.hypot(rise, D), ang, xc, hz + rise / 2, (zRidge + z1) / 2, 'x');
          [x0, x1].forEach(x => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute([x, hz, zRidge, x, hz, z1, x, hz + rise, zRidge], 3));
            g.computeVertexNormals(); archUp.add(new THREE.Mesh(g, mat('#cfc8b8', { side: THREE.DoubleSide })));
          });
        } else if (r.type === 'hip') {                             // 四坡：脊线沿 X 缩短（脊长 = 长 - 进深），四坡面
          const D2 = (z1 - z0) / 2, Lr = Math.max(.8, (x1 - x0) - (z1 - z0));
          const xs0 = xc - Lr / 2, xs1 = xc + Lr / 2;
          const planeQ = (pts, m) => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
            g.computeVertexNormals(); archUp.add(new THREE.Mesh(g, m));
          };
          const rm = roofMat, gm = mat('#cfc8b8', { side: THREE.DoubleSide });
          planeQ([[xs0, hz + rise, zc], [xs1, hz + rise, zc], [x1, hz, z1], [x0, hz, z1]], rm);   // 前坡
          planeQ([[xs0, hz + rise, zc], [xs1, hz + rise, zc], [x1, hz, z0], [x0, hz, z0]], rm);   // 后坡
          planeQ([[xs0, hz + rise, zc], [x0, hz, z0], [x0, hz, z1]], gm);                          // 左端坡
          planeQ([[xs1, hz + rise, zc], [x1, hz, z0], [x1, hz, z1]], gm);                          // 右端坡
          [[xs0, hz + rise, zc], [xs1, hz + rise, zc]].forEach(([px, py, pz]) => {                 // 脊线短横条
            const b = new THREE.Mesh(new THREE.BoxGeometry(.14, .12, .14), gm);
            b.position.set(px, py, pz); archUp.add(b);
          });
        } else {                                                   // 双坡：屋脊在中间 zc，前后两坡
          const D2 = zc - z0, ang = Math.atan2(rise, D2), slope = Math.hypot(rise, D2);
          addPlane(x1 - x0, slope, -ang, xc, hz + rise / 2, z0 + D2 / 2, 'x');
          addPlane(x1 - x0, slope, ang, xc, hz + rise / 2, z1 - D2 / 2, 'x');
          [x0, x1].forEach(x => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute([x, hz, z0, x, hz, z1, x, hz + rise, zc], 3));
            g.computeVertexNormals(); archUp.add(new THREE.Mesh(g, mat('#cfc8b8', { side: THREE.DoubleSide })));
          });
        }
        markNew(s0, 'roof', r.id);
      });
      (state.pergolas || []).forEach(p => {
        const s0 = archUp.children.length;
        const x0 = wx(p.x - p.w / 2), x1 = wx(p.x + p.w / 2), z0 = wz(p.y - p.d / 2), z1 = wz(p.y + p.d / 2);
        const H = M(p.h ?? 2600), ps = M(p.post ?? 150), beam = .18;
        const nx = Math.max(2, Math.round((x1 - x0) / 2.4) + 1), ny = Math.max(2, Math.round((z1 - z0) / 2.4) + 1);
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(ps, H, ps), outWood);
          post.position.set(x0 + (x1 - x0 - ps) * i / (nx - 1) + ps / 2, H / 2, z0 + (z1 - z0 - ps) * j / (ny - 1) + ps / 2);
          post.castShadow = post.receiveShadow = true; archUp.add(post);
          colliders.push([post.position.x - ps / 2, post.position.z - ps / 2, post.position.x + ps / 2, post.position.z + ps / 2, 0, H]);   // 廊架立柱挡人（顶部格栅悬空不挡）
        }
        [z0, z1].forEach(z => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, beam, beam), outWood);
          b.position.set((x0 + x1) / 2, H + beam / 2, z + (z === z0 ? beam / 2 : -beam / 2));
          b.castShadow = b.receiveShadow = true; archUp.add(b);
        });
        const nr = Math.max(2, Math.round((x1 - x0) / .4));
        for (let i = 0; i <= nr; i++) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(.06, .1, z1 - z0), outWood);
          b.position.set(x0 + (x1 - x0) * i / nr, H + beam + .05, (z0 + z1) / 2);
          b.castShadow = true; archUp.add(b);
        }
        markNew(s0, 'pergola', p.id);
      });
      (state.decks || []).forEach(k => {
        const s0 = archUp.children.length;
        const x0 = wx(k.x - k.w / 2), z0 = wz(k.y - k.d / 2), w = M(k.w), d = M(k.d);
        const th = M(k.thick ?? 150), base = M(k.z ?? 0);
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w, th, d), outWood);
        slab.position.set(wx(k.x), base + th / 2, wz(k.y));
        slab.castShadow = slab.receiveShadow = true; archUp.add(slab);
        const seamMat = mat('#6f5a42', { roughness: .9 });
        const n = Math.min(60, Math.max(1, Math.round(w / .15)));
        for (let i = 1; i < n; i++) {
          const s = new THREE.Mesh(new THREE.BoxGeometry(.008, .004, d - .02), seamMat);
          s.position.set(x0 + w * i / n, base + th + .002, wz(k.y)); archUp.add(s);
        }
        markNew(s0, 'deck', k.id);
      });
      (state.pools || []).forEach(p => {
        const s0 = archUp.children.length;
        const x0 = wx(p.x - p.w / 2), z0 = wz(p.y - p.d / 2), w = M(p.w), d = M(p.d);
        const cp = M(Math.min(p.coping ?? 300, Math.min(p.w, p.d) / 3));
        const copMat = mat('#cfc6b4', { roughness: .9 }), waterMat = mat('#5fb3c8', { roughness: .15, metalness: .1, transparent: true, opacity: .82 });
        const water = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(.1, w - cp * 2), Math.max(.1, d - cp * 2)), waterMat);
        water.rotation.x = -Math.PI / 2; water.position.set(wx(p.x), .03, wz(p.y)); water.receiveShadow = true; archUp.add(water);
        const curb = (cw, cd, px, pz) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(cw, .12, cd), copMat);
          b.position.set(px, .06, pz); b.castShadow = b.receiveShadow = true; archUp.add(b);
        };
        curb(w, cp, wx(p.x), z0 + cp / 2); curb(w, cp, wx(p.x), z0 + d - cp / 2);
        curb(cp, d - cp * 2, x0 + cp / 2, wz(p.y)); curb(cp, d - cp * 2, x0 + w - cp / 2, wz(p.y));
        colliders.push([x0 + cp, z0 + cp, x0 + w - cp, z0 + d - cp, 0, 1e9, 'water']);   // 泳池水体占碰撞：不能走进水里（池沿可绕行）；带 water 标记：全高挡人但不作墙顶类支撑面
        markNew(s0, 'pool', p.id);
      });
      (state.gates || []).forEach(g => {                     // 院门：两端门柱 + 双扇外开门扇（按开启角度，3D 可点击开关）
        const s0 = archUp.children.length;
        const A = [wx(g.a[0]), wz(g.a[1])], B = [wx(g.b[0]), wz(g.b[1])];
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < .4) return;
        const ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L;
        const sd = g.flip ? -1 : 1;                               // 开向：翻转后朝另一侧
        const ang = Math.max(0, Math.min(90, g.ang ?? 30)) * Math.PI / 180;
        const GH = Math.max(1.2, Math.min(3, (g.h ?? 1800) / 1000));
        const postMat = mat('#6f5a45', { roughness: .85 }), leafMat = mat('#8a7257', { roughness: .75 });
        const PS = .16, PH = GH + .15;
        [A, B].forEach(P => {
          const post = new THREE.Mesh(new THREE.BoxGeometry(PS, PH, PS), postMat);
          post.position.set(P[0], PH / 2, P[1]); post.castShadow = post.receiveShadow = true; archUp.add(post);
          colliders.push([P[0] - PS / 2, P[1] - PS / 2, P[0] + PS / 2, P[1] + PS / 2, 0, PH]);   // 门柱挡人
        });
        const addLeaf = (O, dir, trim = 0) => {                // O 铰链点，dir 关门时门扇沿墙的朝向，trim 中缝留缝
          const base = Math.atan2(-uz * dir, ux * dir), Lh = Math.max(.2, L / 2 - PS / 2 - trim), HH = Math.max(.4, GH - .05);
          const outer = new THREE.Group(); outer.position.set(O[0], 0, O[1]); outer.rotation.y = base;
          const pg = new THREE.Group();
          const leaf = { pivot: pg, a0: 0, a1: -dir * sd * Math.PI / 2, open: false, cur: 0, len: Lh };   // 默认关闭，点击门扇完全打开 90°；len 供碰撞按实际扇宽判定
          pg.rotation.y = leaf.cur;
          const pane = new THREE.Mesh(new THREE.BoxGeometry(Lh, HH, .05), leafMat);
          pane.position.set(Lh / 2, HH / 2, 0); pane.castShadow = true; pane.userData.door = leaf; pg.add(pane);
          for (let i = 1; i <= 3; i++) {                        // 竖梃
            const bar = new THREE.Mesh(new THREE.BoxGeometry(.05, HH, .07), postMat);
            bar.position.set(Lh * i / 4, HH / 2, 0); bar.castShadow = true; bar.userData.door = leaf; pg.add(bar);
          }
          [.18, GH - .18].forEach(y => {                         // 上下横档
            const rail = new THREE.Mesh(new THREE.BoxGeometry(Lh, .07, .07), postMat);
            rail.position.set(Lh / 2, y, 0); rail.castShadow = true; rail.userData.door = leaf; pg.add(rail);
          });
          pg.userData.door = leaf; outer.add(pg); doors.push(leaf); archUp.add(outer);
        };
        addLeaf([A[0] + ux * PS / 2, A[1] + uz * PS / 2], 1);
        addLeaf([B[0] - ux * PS / 2, B[1] - uz * PS / 2], -1, .01);   // 右扇少 10mm，关合时中缝不重合闪面
        markNew(s0, 'gate', g.id);
      });
      /* ===== 停车场配套 19 件 3D =====
         车位 / 箭头 / 网格 / 标线用画布贴图平面贴地；设备按机箱 + 立杆 + 灯箱建模；
         升降柱 / 伸缩门 / 车位灯 / 充电桩可交互，动画态进 parkAnims，灯色由 applyParkVisual 统一刷新。 */
      const SAN_KEYS = ['sanSortBin','sanLitterBin','sanCollectPoint','sanGarbageRoom','sanToilet','sanMobileToilet','sanWashBasin','sanToolCabinet','sanWaterPoint','sanTransferStation','sanRecycleStation','sanRestRoom'];
      const isSan = t => SAN_KEYS.includes(t);
      const WT_KEYS = ['wtStation','wtHopper','wtCompactor','wtBox','wtScale','wtMist','wtSump','wtWash'];
      const isWt = t => WT_KEYS.includes(t);
      const parkTexCache = new Map();
      function parkTex(key, wmm, dmm, draw) {                     // 画布贴图（按宽高比生成，key 相同的复用）
        let t = parkTexCache.get(key);
        if (t) return t;
        const cv = document.createElement('canvas');
        const ratio = Math.max(.05, Math.min(4, (dmm || 1) / Math.max(1, wmm || 1)));
        cv.width = 640; cv.height = Math.max(24, Math.min(1024, Math.round(640 * ratio)));
        draw(cv.getContext('2d'), cv.width, cv.height);
        t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
        parkTexCache.set(key, t); return t;
      }
      function buildPark3D(T3, e, ctx) {
        const grp = ctx.grp, P = ctx.P, colliders = ctx.colliders, px = ctx.px, pz = ctx.pz, ang = ctx.ang, W = ctx.W, h = ctx.h, poleM = ctx.poleM, darkM = ctx.darkM;
        const D = Math.max(.2, M(e.d || 1200));
        const ca = Math.cos(ang), sa = Math.sin(ang), wp = (lx, lz) => [px + lx * ca - lz * sa, pz + lx * sa + lz * ca];
        const foot = (w2, d2, y1) => {                            // 旋转后的整体占地（AABB）+ 高度
          const ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
          colliders.push([px - ww, pz - dd, px + ww, pz + dd, 0, y1]);
        };
        const small = (lx, lz, r, y1) => { const q = wp(lx, lz); colliders.push([q[0] - r, q[1] - r, q[0] + r, q[1] + r, 0, y1]); };
        const steel = mat('#8d949a', { metalness: .55, roughness: .45 }), stone = mat('#b7b1a3', { roughness: .9 });
        const mk = (tex, w2, d2, y2) => {                         // 贴地贴图平面（局部 +x = 朝向，画布 x 沿朝向、y 横向）
          const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(.05, w2), Math.max(.05, d2)), oneMat(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
          m.rotation.x = -Math.PI / 2; m.position.y = y2 || .01; m.renderOrder = 3; grp.add(m); return m;
        };
        const face = (tex, w2, h2, x, y, z, ry) => {
          const m = new THREE.Mesh(new THREE.PlaneGeometry(w2, h2), oneMat(new THREE.MeshBasicMaterial({ map: tex, transparent: true })));
          m.position.set(x, y, z); m.rotation.y = ry; grp.add(m); return m;
        };
        const txtTex = (key, w2, h2, txt, bg, fg, fs) => parkTex(key, w2, h2, (g, cw2, ch2) => {
          if (bg) { g.fillStyle = bg; g.fillRect(0, 0, cw2, ch2); }
          g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
          let size = fs || Math.round(ch2 * .58);
          g.font = `bold ${size}px "Microsoft YaHei", sans-serif`;
          const maxW = cw2 * .9;                                   // 牌面两侧留边，文字不越出牌宽
          const tw = g.measureText(txt).width;
          if (tw > maxW) { size = Math.max(10, Math.floor(size * maxW / tw)); g.font = `bold ${size}px "Microsoft YaHei", sans-serif`; }
          g.fillText(txt, cw2 / 2, ch2 / 2);
        });
        /* —— 车位标线 —— */
        if (T3 === 'facAccessStall' || T3 === 'facEvStall') {      // 无障碍 / 充电车位：蓝色 / 绿色车位线 + 标识
          const acc = T3 === 'facAccessStall';
          mk(parkTex('st' + T3 + Math.round(W * 100) + Math.round(D * 100), W * 1000, D * 1000, (g, cw2, ch2) => {
            g.fillStyle = acc ? 'rgba(63,127,208,.32)' : 'rgba(63,157,92,.32)'; g.fillRect(0, 0, cw2, ch2);
            g.strokeStyle = acc ? '#e2ecf8' : '#e2f5e9'; g.lineWidth = Math.max(5, cw2 * .02);
            g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, cw2 - g.lineWidth, ch2 - g.lineWidth);
            g.fillStyle = acc ? '#eaf2fb' : '#e6f7ec'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.font = `bold ${Math.round(Math.min(cw2, ch2) * .5)}px "Microsoft YaHei", sans-serif`;
            g.fillText(acc ? '♿' : '⚡', cw2 * .5, ch2 * .5);
          }), W, D);
          return;
        }
        if (T3 === 'facGroundArrow') {                             // 地面导向箭头：白色箭头（直行 / 转弯 / 直行+左转）
          const style = e.style || 'straight', turn = style === 'left' || style === 'right' || style === 'straightLeft';
          const AP = turn ? Math.max(D, W * .6) : D;               // 转弯箭头画布留足横向空间，避免切边
          mk(parkTex('ga' + style + Math.round(W * 100) + Math.round(AP * 100), W * 1000, AP * 1000, (g, cw2, ch2) => {
            const arrow = (cx, cy, len, rot) => {
              const tw = Math.min(ch2 * .42, len * .3), hd = len * .38, hw = len * .3;
              g.save(); g.translate(cx, cy); g.rotate(rot); g.beginPath();
              g.moveTo(-len / 2, -tw / 2); g.lineTo(len / 2 - hd, -tw / 2); g.lineTo(len / 2 - hd, -hw / 2);
              g.lineTo(len / 2, 0); g.lineTo(len / 2 - hd, hw / 2); g.lineTo(len / 2 - hd, tw / 2); g.lineTo(-len / 2, tw / 2);
              g.closePath(); g.fill(); g.restore();
            };
            g.fillStyle = 'rgba(246,246,240,.96)';
            const L2 = Math.min(cw2 * .94, ch2 * 1.3);
            if (style === 'left' || style === 'right') arrow(cw2 * .5, ch2 * .5, L2, (style === 'left' ? -1 : 1) * Math.PI / 3);
            else if (style === 'straightLeft') { arrow(cw2 * .52, ch2 * .5, cw2 * .92, 0); arrow(cw2 * .42, ch2 * .5, cw2 * .58, -Math.PI / 2.8); }
            else arrow(cw2 * .5, ch2 * .5, cw2 * .94, 0);
          }), W, AP);
          return;
        }
        if (T3 === 'facNoParkGrid') {                              // 禁停网格：黄底 + 交叉线
          mk(parkTex('ng' + Math.round(W * 100) + Math.round(D * 100), W * 1000, D * 1000, (g, cw2, ch2) => {
            g.fillStyle = 'rgba(232,180,74,.20)'; g.fillRect(0, 0, cw2, ch2);
            g.strokeStyle = 'rgba(214,154,30,.95)'; g.lineWidth = Math.max(3, cw2 * .01);
            const n = Math.max(2, Math.round((W + D) / 1.4));
            for (let i = 1; i < n; i++) { const t = cw2 * i / n; g.beginPath(); g.moveTo(t, 0); g.lineTo(t, ch2); g.stroke(); }
            for (let j = 1; j < n; j++) { const t = ch2 * j / n; g.beginPath(); g.moveTo(0, t); g.lineTo(cw2, t); g.stroke(); }
          }), W, D);
          return;
        }
        if (T3 === 'facRoadMark') {                                // 车道标线：虚线 / 实线 / 停止线
          const lw = Math.max(.06, M(e.h || 150)), dash = e.style === 'dash';
          mk(parkTex('rm' + (dash ? 'd' : 's') + Math.round(W * 100) + Math.round(lw * 1000), W * 1000, lw * 1000, (g, cw2, ch2) => {
            g.fillStyle = '#f7f7f2';
            if (dash) { const seg = cw2 / 6; for (let i = 0; i < 6; i += 2) g.fillRect(i * seg, 0, seg * .92, ch2); }
            else g.fillRect(0, 0, cw2, ch2);
          }), W, lw);
          return;
        }
        /* —— 出入口设备 —— */
        if (T3 === 'facTicketMachine') {                           // 取卡机：底座 + 机箱 + 取卡口 + 按键屏
          P(new THREE.BoxGeometry(W + .12, .08, D + .12), stone, 0, .04, 0);
          P(new THREE.BoxGeometry(W, h, D), mat('#e8e4da', { roughness: .7 }), 0, h / 2, 0);
          P(new THREE.BoxGeometry(.04, .14, D * .55), mat('#2c3842'), W / 2 + .012, h * .58, 0);
          P(new THREE.BoxGeometry(.04, .2, D * .68), mat('#1f6f9e'), W / 2 + .012, h * .82, 0);
          small(0, 0, Math.max(W, D) / 2 + .06, Math.min(h, 2));
          return;
        }
        if (T3 === 'facEntrySign') {                               // 出入口指示牌：立杆 + 悬挑横臂 + 双面牌（文字朝两面）
          const arm = Math.max(.3, D), ph = Math.max(.32, W * .55), top = h;
          P(new THREE.CylinderGeometry(.1, .13, .18, 12), stone, 0, .09, 0);
          P(new THREE.CylinderGeometry(.05, .075, top - .18, 12), poleM, 0, .18 + (top - .18) / 2, 0);
          P(new THREE.BoxGeometry(arm, .07, .07), poleM, arm / 2, top - .2, 0);
          P(new THREE.BoxGeometry(.1, ph, W), mat('#1565a8', { roughness: .5 }), arm, top - .24 - ph / 2, 0);
          const tex = txtTex('es' + (e.side === 'out' ? 'o' : 'i') + Math.round(W * 100) + Math.round(ph * 100), W * 1000, ph * 1000,
            (e.side === 'out' ? '出口  →' : '入口  →'), '#1565a8', '#ffffff');
          face(tex, W, ph, arm + .056, top - .24 - ph / 2, 0, Math.PI / 2);
          face(tex, W, ph, arm - .056, top - .24 - ph / 2, 0, -Math.PI / 2);
          small(0, 0, .12, Math.min(top, 2.4));
          return;
        }
        if (T3 === 'facFreeSpace') {                               // 余位显示屏：立杆 + 黑色 LED 屏（P + 余位数）
          const ph = Math.max(.32, W * .42), cy = h - ph / 2 - .1;
          P(new THREE.CylinderGeometry(.06, .085, h, 10), poleM, 0, h / 2, 0);
          P(new THREE.BoxGeometry(.12, ph + .1, W + .1), darkM, 0, cy, 0);
          face(txtTex('fs' + Math.round(e.n ?? 88) + Math.round(W * 100), W * 1000, ph * 1000, 'P ' + Math.round(e.n ?? 88), '#0d1116', '#7ef0a0'), W, ph, .066, cy, 0, Math.PI / 2);
          small(0, 0, .1, Math.min(h, 2.4));
          return;
        }
        if (T3 === 'facRisingBollard') {                           // 升降柱：柱体 + 反光环，升起 / 落下带动画
          const g2 = new THREE.Group(); grp.add(g2);
          const body = new THREE.Mesh(new THREE.CylinderGeometry(W / 2, W / 2, h, 18), mat('#c6cbd0', { metalness: .65, roughness: .32 }));
          body.position.y = h / 2; body.castShadow = body.receiveShadow = true; g2.add(body);
          const cap = new THREE.Mesh(new THREE.SphereGeometry(W / 2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat('#9aa1a6', { metalness: .6, roughness: .4 }));
          cap.position.y = h; g2.add(cap);
          [h * .22, h * .82].forEach(y => {
            const ring = new THREE.Mesh(new THREE.CylinderGeometry(W / 2 + .005, W / 2 + .005, .055, 18), mat('#e0a92e', { roughness: .5 }));
            ring.position.y = y; g2.add(ring);
          });
          g2.traverse(o => { if (o.isMesh) o.userData.park = { kind: 'bollard', id: e.id }; });
          parkAnims.push({ id: e.id, kind: 'bollard', open: e.up === true, cur: e.up === true ? 1 : 0, apply: k => { g2.position.y = -(1 - k) * Math.max(.05, h - .16); } });
          parkAnims[parkAnims.length - 1].apply(parkAnims[parkAnims.length - 1].cur);
          small(0, 0, W / 2 + .02, Math.min(h, 1));
          return;
        }
        if (T3 === 'facRetractGate') {                             // 伸缩门：折叠栅格（收拢时沿门宽压缩到一端）
          const g2 = new THREE.Group(); g2.position.x = -W / 2; grp.add(g2);
          const n = Math.max(6, Math.round(W / .6)), seg = W / n;
          for (let i = 0; i < n; i++) {
            const x0 = seg * (i + .5), back = i % 2 ? 1 : -1;
            const post = new THREE.Mesh(new THREE.BoxGeometry(.05, h, .05), steel);
            post.position.set(x0, h / 2, back * .07); post.castShadow = true; g2.add(post);
            const diag = new THREE.Mesh(new THREE.BoxGeometry(seg * 1.18, .04, .04), steel);   // 交叉斜撑
            diag.position.set(x0, h * .5, 0); diag.rotation.z = back * .42; g2.add(diag);
            const diag2 = new THREE.Mesh(new THREE.BoxGeometry(seg * 1.18, .035, .035), steel);
            diag2.position.set(x0, h * .82, 0); diag2.rotation.z = -back * .3; g2.add(diag2);
          }
          const rail = P(new THREE.BoxGeometry(W, .06, .12), steel, 0, .03, 0);
          P(new THREE.CylinderGeometry(.09, .11, h + .2, 12), poleM, -W / 2 + .06, (h + .2) / 2, 0);
          rail.userData.park = { kind: 'gate', id: e.id };                             // 导轨也可点（门体收拢后仍能点中）
          g2.traverse(o => { if (o.isMesh) o.userData.park = { kind: 'gate', id: e.id }; });
          parkAnims.push({ id: e.id, kind: 'gate', open: e.open === true, cur: e.open === true ? 1 : 0, apply: k => { g2.scale.x = Math.max(.04, 1 - .92 * k); } });
          parkAnims[parkAnims.length - 1].apply(parkAnims[parkAnims.length - 1].cur);
          return;
        }
        /* —— 车位引导与配套 —— */
        if (T3 === 'facStallSensor') {                             // 车位指示灯：立杆 + 悬臂 + 红/绿灯头（可点切换）
          P(new THREE.CylinderGeometry(.04, .05, h, 10), poleM, 0, h / 2, 0);
          P(new THREE.BoxGeometry(.46, .05, .05), poleM, .23, h - .07, 0);
          const lamp = P(new THREE.SphereGeometry(Math.max(.055, W / 2), 16, 12), oneMat(new THREE.MeshBasicMaterial({ color: 0x3cc46e })), .46, h - .14, 0);
          lamp.userData.park = { kind: 'sensor', id: e.id };
          parkLamps.set('sensor' + e.id, lamp);
          small(0, 0, .07, Math.min(h, 2.2));
          return;
        }
        if (T3 === 'facZoneScreen') {                              // 分区引导屏：立杆 + 屏（分区字母 + 余位数）
          const ph = Math.max(.32, W * .4), cy = h - ph / 2 - .1, zn = (e.zn || 'A').slice(0, 3);
          P(new THREE.CylinderGeometry(.06, .085, h, 10), poleM, 0, h / 2, 0);
          P(new THREE.BoxGeometry(.12, ph + .1, W + .1), darkM, 0, cy, 0);
          face(txtTex('zs' + zn + Math.round(e.n ?? 36) + Math.round(W * 100), W * 1000, ph * 1000, `${zn}  ${Math.round(e.n ?? 36)}`, '#0d1116', '#ffd75e'), W, ph, .066, cy, 0, Math.PI / 2);
          small(0, 0, .1, Math.min(h, 2.4));
          return;
        }
        if (T3 === 'facFindKiosk') {                               // 反向寻车机：立柜 + 触摸屏
          P(new THREE.BoxGeometry(W + .06, .06, D + .06), stone, 0, .03, 0);
          P(new THREE.BoxGeometry(W, h - .08, D), mat('#d8d4c8', { roughness: .65 }), 0, h / 2, 0);
          P(new THREE.BoxGeometry(.06, h * .46, D * .78), mat('#1d2a36'), W / 2 + .02, h * .68, 0);
          face(txtTex('fk' + Math.round(W * 100), D * 700, h * 400, '寻车', '#12202c', '#8fd0ff'), D * .7, h * .4, W / 2 + .055, h * .68, 0, Math.PI / 2);
          P(new THREE.BoxGeometry(.06, h * .1, D * .5), mat('#c9c5b9'), W / 2 + .02, h * .3, 0);
          small(0, 0, Math.max(W, D) / 2 + .05, Math.min(h, 2));
          return;
        }
        if (T3 === 'facEvCharger') {                               // 充电桩：桩体 + 屏 + 充电枪 + 状态灯（可点切换）
          P(new THREE.BoxGeometry(W + .08, .1, D + .08), stone, 0, .05, 0);
          P(new THREE.BoxGeometry(W, h - .1, D), mat('#eceae2', { roughness: .6 }), 0, h / 2, 0);
          P(new THREE.BoxGeometry(.05, h * .3, D * .66), mat('#20415e'), W / 2 + .02, h * .7, 0);
          P(new THREE.BoxGeometry(.05, .18, D * .3), mat('#2f7fd0'), W / 2 + .02, h * .42, 0);       // 充电枪座
          const gun = P(new THREE.BoxGeometry(.1, .18, .1), mat('#2f2f33', { metalness: .4 }), W / 2 + .09, h * .42, D * .28);
          gun.rotation.z = -.3;
          const lamp = P(new THREE.SphereGeometry(.05, 14, 10), oneMat(new THREE.MeshBasicMaterial({ color: 0x3cc46e })), W / 2 + .03, h * .92, 0);
          lamp.userData.park = { kind: 'charger', id: e.id };
          parkLamps.set('charger' + e.id, lamp);
          small(0, 0, Math.max(W, D) / 2 + .06, Math.min(h, 2));
          return;
        }
        if (T3 === 'facPvCarport') {                               // 光伏车棚：四角钢柱 + 顶棚 + 光伏板格
          const roofT = .12;
          [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz]) => {
            const lx = sx * Math.max(.2, W / 2 - .18), lz = sz * Math.max(.2, D / 2 - .18);
            P(new THREE.BoxGeometry(.14, h, .14), steel, lx, h / 2, lz);
            small(lx, lz, .12, h);
          });
          P(new THREE.BoxGeometry(W + .3, roofT, D + .3), steel, 0, h + roofT / 2, 0);
          const tex = parkTex('pv' + Math.round(W * 100) + Math.round(D * 100), W * 1000, D * 1000, (g, cw2, ch2) => {
            g.fillStyle = '#1e3450'; g.fillRect(0, 0, cw2, ch2);
            g.strokeStyle = '#7fa8c9'; g.lineWidth = 2;
            const nx = Math.max(2, Math.round(W / 1.3)), ny = Math.max(2, Math.round(D / 1.3));
            for (let i = 1; i < nx; i++) { g.beginPath(); g.moveTo(cw2 * i / nx, 0); g.lineTo(cw2 * i / nx, ch2); g.stroke(); }
            for (let j = 1; j < ny; j++) { g.beginPath(); g.moveTo(0, ch2 * j / ny); g.lineTo(cw2, ch2 * j / ny); g.stroke(); }
          });
          const top = new THREE.Mesh(new THREE.PlaneGeometry(W + .26, D + .26), oneMat(new THREE.MeshBasicMaterial({ map: tex })));
          top.rotation.x = -Math.PI / 2; top.position.y = h + roofT + .002; grp.add(top);
          return;
        }
        if (T3 === 'facDrain') {                                   // 排水沟：沟槽 + 雨水篦子
          const wid = Math.max(.15, M(e.h || 300));
          P(new THREE.BoxGeometry(W, .1, wid + .1), stone, 0, .04, 0);
          P(new THREE.BoxGeometry(W - .04, .08, wid), mat('#333a40', { roughness: .95 }), 0, .07, 0);
          const n = Math.max(2, Math.round(W / .3));
          for (let i = 0; i < n; i++) P(new THREE.BoxGeometry(W / n * .5, .03, wid), mat('#9aa1a6', { metalness: .55, roughness: .5 }), -W / 2 + (i + .5) * W / n, .12, 0);
          return;
        }
        if (T3 === 'facHydrant') {                                 // 消防栓：红色栓体 + 顶帽 + 两侧出水口
          const r = Math.max(.06, W / 2), red = mat('#cf3126', { roughness: .55 });
          P(new THREE.CylinderGeometry(r * 1.6, r * 1.8, .07, 14), stone, 0, .035, 0);
          P(new THREE.CylinderGeometry(r, r * 1.08, h - .2, 16), red, 0, (h - .2) / 2 + .07, 0);
          P(new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), red, 0, h - .13, 0);
          P(new THREE.BoxGeometry(r * 2.8, r * .8, r * .8), red, 0, h * .62, 0, 0);
          P(new THREE.BoxGeometry(r * .8, r * .8, r * 2.6), red, 0, h * .62, 0, 0);
          foot(W * 1.9, W * 1.9, Math.min(h, 1.2));
          return;
        }
        if (T3 === 'facStackPark') {                               // 升降横移车库：钢架 + 每格独立载车板（点击存 / 取车）
          const lv = Math.max(2, Math.round(e.lv ?? 2)), cl = Math.max(1, Math.round(e.col ?? 3)), lh = h / lv;
          const cw = W / cl, st = e.st || {};
          [-1, 1].forEach(sx => [-1, 1].forEach(sz => P(new THREE.BoxGeometry(.14, h, .14), steel, sx * (W / 2 - .1), h / 2, sz * (D / 2 - .1))));
          for (let i = 1; i <= lv; i++) {
            const y = lh * i;
            P(new THREE.BoxGeometry(W, .12, .14), steel, 0, y, -D / 2 + .1);                  // 背侧横梁
            P(new THREE.BoxGeometry(.14, .12, D), steel, -W / 2 + .1, y, 0);                   // 左侧纵梁
            P(new THREE.BoxGeometry(.14, .12, D), steel, W / 2 - .1, y, 0);                    // 右侧纵梁
            if (i === lv) P(new THREE.BoxGeometry(W, .12, .14), steel, 0, y, D / 2 - .1);      // 正面只在顶部留一道门梁，下面各层敞开进车
            for (let j = 0; j < cl; j++) {                          // 每格一块载车板：独立 Group 便于上下升降
              const cx2 = -W / 2 + (j + .5) * cw, baseY = i === 1 ? .02 : lh * i - .04;   // 地面层压到地面齐平（6cm 板唇），车可直接开上去
              const cg = new THREE.Group(); cg.position.set(cx2, baseY, 0); grp.add(cg);
              const tag = { kind: 'stack', id: e.id, cell: i + '_' + j, lv: i, col: j + 1 };
              const plate = new THREE.Mesh(new THREE.BoxGeometry(cw - .16, .08, D - .34), mat('#b9c0c6', { metalness: .3, roughness: .6 }));
              plate.castShadow = plate.receiveShadow = true; plate.position.y = 0; plate.userData.park = tag; cg.add(plate);
              const cell = { g: cg, baseY, drop: Math.max(0, baseY - .02), cw: cw - .3, dep: D - .7, car: null, target: !!st[i + '_' + j] };
              stackCells.set(e.id + '_' + i + '_' + j, cell);
              if (cell.target) { cell.car = stackCar(cg, cell.cw, cell.dep, tag); }
            }
          }
          foot(W, D, h);
          return;
        }
        if (T3 === 'facRotaryPark') {                              // 垂直循环车库：双侧钢塔 + 上下循环载车板
          const n = Math.max(4, Math.round(e.n ?? 8)), rows = Math.ceil(n / 2), ph = h / rows;
          [-1, 1].forEach(sz => [-1, 1].forEach(sx => P(new THREE.BoxGeometry(.16, h, .16), steel, sx * (W / 2 - .1), h / 2, sz * (D / 2 - .12))));
          [-1, 1].forEach(sz => {
            P(new THREE.BoxGeometry(W, .12, .12), steel, 0, h, sz * (D / 2 - .12));
            P(new THREE.BoxGeometry(W, .1, .12), steel, 0, .06, sz * (D / 2 - .12));
          });
          for (let i = 0; i < rows; i++) {
            [-1, 1].forEach((sd, k) => {
              if (i * 2 + k >= n) return;
              const y = ph * (i + .5);
              P(new THREE.BoxGeometry(W - .3, .07, D / 2 - .3), mat('#b9c0c6', { metalness: .3, roughness: .6 }), 0, y, sd * (D / 4));
            });
          }
          foot(W, D, h);
          return;
        }
        /* ===== 环卫配套 12 件 3D =====
           全部可交互：主体打 userData.park={kind:'san',id}，状态部件登记到 sanVisuals，
           由 applyParkVisual 统一刷灯色 / 盖门开合 / 水流；开合动画进 parkAnims。 */
        if (isSan(T3)) { buildSan3D(T3, e, ctx, sanVisuals, parkAnims, oneMat, mat); return; }
        if (isWt(T3)) { buildWt3D(T3, e, ctx, wtVisuals, wtRuns, parkAnims, oneMat, mat, parkTex, txtTex); return; }
        if (T3 === 'facCarWash') { buildWash3D(e, ctx, washVisuals, oneMat, mat); return; }
      }
      /* 环卫配套 12 件 3D 建模：统一在主体打 park 标记；开盖 / 开门 / 水流进 parkAnims 动画，
         状态灯进 sanVisuals.lamps，由 applyParkVisual 按 e.on 刷色。ctx 提供 grp/P/colliders/W/h 等。 */
      function buildSan3D(T3, e, ctx, visuals, anims, oneMat, mat) {
        const { grp, P, colliders, doors, px, pz, ang, W, h, poleM, darkM } = ctx;
        const D = Math.max(.2, M(e.d || 1200)), on = e.on === true;
        const ca = Math.cos(ang), sa = Math.sin(ang), wp = (lx, lz) => [px + lx * ca - lz * sa, pz + lx * sa + lz * ca];
        const foot = (w2, d2, y1) => { const ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2; colliders.push([px - ww, pz - dd, px + ww, pz + dd, 0, y1]); };
        const small = (lx, lz, r, y1) => { const q = wp(lx, lz); colliders.push([q[0] - r, q[1] - r, q[0] + r, q[1] + r, 0, y1]); };
        const steel = mat('#9aa1a8', { metalness: .5, roughness: .5 });
        const vis = { kind: T3, lamps: [], on };
        visuals.set(String(e.id), vis);
        const tag = o => { o.traverse(x => { if (x.isMesh) x.userData.park = { kind: 'san', id: e.id }; }); return o; };
        // 灯：注册到 vis.lamps，on/off 两个十六进制色；emissive 材质便于自发光
        const lamp = (mesh, offHex, onHex) => {
          mesh.material = oneMat(new THREE.MeshBasicMaterial({ color: on ? onHex : offHex }));
          vis.lamps.push({ mesh, onHex, offHex }); return mesh;
        };
        // 动画：g 为要动的 Group，apply(k) 由 parkAnims 每帧调用；on 决定初值
        const anim = (g, applyFn) => {
          const a = { id: e.id, kind: 'san', open: on, cur: on ? 1 : 0, apply: applyFn };
          anims.push(a); a.apply(a.cur); return a;
        };

        if (T3 === 'sanSortBin') {                              // 分类垃圾桶：蓝红绿灰四色空心桶，四个桶盖各自独立开合
          const cols = ['#2f7fd0', '#cf4b42', '#3f9d5c', '#8a9299'], bw = W / 4 * .88, gap = W / 4;
          const bh = h * .86, bd = D * .82, t = Math.min(.035, bw * .16, bd * .12);   // 桶壁厚（限制上限，保证内腔够大）
          const bins = sanBinStates(e), binAnims = [];
          for (let i = 0; i < 4; i++) {
            const bx = -W / 2 + gap * (i + .5), shell = mat(cols[i], { roughness: .82 });
            const btag = { kind: 'san', id: e.id, part: i };    // 带桶索引的拾取标记：点哪个桶只切哪个桶
            const put = (geo, m, x, y, z) => { const o = P(geo, m, x, y, z); o.userData.park = btag; return o; };
            // 四壁围成空桶、深色底板作内胆；开盖后从上方看到的是空腔而非实心彩色顶面
            put(new THREE.BoxGeometry(t, bh, bd), shell, bx - bw / 2 + t / 2, bh / 2, 0);            // 左壁
            put(new THREE.BoxGeometry(t, bh, bd), shell, bx + bw / 2 - t / 2, bh / 2, 0);            // 右壁
            put(new THREE.BoxGeometry(bw - 2 * t, bh, t), shell, bx, bh / 2, -bd / 2 + t / 2);       // 后壁
            put(new THREE.BoxGeometry(bw - 2 * t, bh, t), shell, bx, bh / 2, bd / 2 - t / 2);        // 前壁
            put(new THREE.BoxGeometry(bw - 2 * t, t, bd - 2 * t), darkM, bx, t / 2, 0);              // 深色桶底 / 内胆
            // 桶身正面分类图标牌：Canvas 贴图（图形 + 中文），四桶各异，朝本地 +z；带同一桶拾取标记
            const pw2 = bw * .74, ph2 = Math.min(bh * .46, pw2 * 1.25);
            const plate = new THREE.Mesh(new THREE.PlaneGeometry(pw2, ph2), oneMat(new THREE.MeshBasicMaterial({ map: binSignTexture(i), transparent: true, depthWrite: false, toneMapped: false })));
            plate.position.set(bx, bh * .58, bd / 2 + .006); plate.userData.park = btag; plate.castShadow = false; grp.add(plate);
            const hinge = new THREE.Group(); hinge.position.set(bx, bh, -D * .4); grp.add(hinge);
            const lid = new THREE.Mesh(new THREE.BoxGeometry(bw * .98, .06, D * .84), mat(cols[i], { roughness: .6 }));
            lid.position.set(0, .03, D * .4); lid.castShadow = true; lid.userData.park = btag; hinge.add(lid);
            const a = anim(null, k => { hinge.rotation.x = -k * 1.15; });   // 盖绕后沿上翻：每桶一条独立动画
            a.open = bins[i] === true; a.cur = a.open ? 1 : 0; a.apply(a.cur);
            binAnims.push(a);
          }
          vis.binAnims = binAnims;
          small(0, 0, Math.max(W, D) / 2, Math.min(h, 1.6));
        } else if (T3 === 'sanLitterBin') {                      // 果皮箱：空心圆桶（薄壁 + 深色内胆底）+ 翻盖，开盖看得见桶内空腔
          const R = W / 2, rb = R * .92, bh = h * .9, t = Math.min(.035, R * .18);
          const shell = mat('#b9c2c9', { metalness: .4, roughness: .55, side: THREE.DoubleSide });
          P(new THREE.CylinderGeometry(R, rb, bh, 24, 1, true), shell, 0, bh / 2, 0);                                                                         // 外壁（上下敞口）
          P(new THREE.CylinderGeometry(R - t, rb - t, bh - t, 24, 1, true), mat('#8d989f', { roughness: .8, side: THREE.DoubleSide }), 0, t + (bh - t) / 2, 0);  // 内壁（略暗，俯视可见）
          P(new THREE.RingGeometry(R - t, R, 24), shell, 0, bh, 0).rotation.x = -Math.PI / 2;                                                                // 桶口顶沿封边
          P(new THREE.CylinderGeometry(rb - t, rb - t, t, 24), darkM, 0, t / 2, 0);                                                                         // 深色内胆底板
          // 桶身正面果皮箱图标牌：取圆柱面正前一段弧贴 Canvas 贴图，贴合弧面不悬空
          const arc = Math.min(1.15, 2.1 * R), arcR = R + .005;
          const plate = new THREE.Mesh(new THREE.CylinderGeometry(arcR, arcR, Math.min(bh * .46, arc * 1.25), 20, 1, true, -arc / (2 * arcR), arc / arcR),
            oneMat(new THREE.MeshBasicMaterial({ map: binSignTexture(4), transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })));
          plate.position.y = bh * .58; plate.userData.park = { kind: 'san', id: e.id }; plate.castShadow = false; grp.add(plate);
          const hinge = new THREE.Group(); hinge.position.set(0, h * .9, -W * .5); grp.add(hinge);
          const lid = new THREE.Mesh(new THREE.CylinderGeometry(W * .54, W * .54, .06, 16), darkM);
          lid.position.set(0, .03, W * .5); hinge.add(lid);
          hinge.traverse(x => { if (x.isMesh) x.userData.park = { kind: 'san', id: e.id }; });
          const a = anim(null, k => hinge.rotation.x = -k * 1.2);
          vis.doors = [{ a, lids: [hinge] }];
          small(0, 0, W * .55, Math.min(h, 1.2));
        } else if (T3 === 'sanCollectPoint') {                   // 垃圾收集点：四立柱 + 顶棚 + 空心桶列（各桶独立开盖）+ 状态灯
          const ph = h, baseTag = { kind: 'san', id: e.id };
          [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sx, sy]) => { const o = P(new THREE.CylinderGeometry(.045, .045, ph, 8), poleM, sx*(W/2-.12), ph/2, sy*(D/2-.12)); o.userData.park = baseTag; });
          const roof = P(new THREE.BoxGeometry(W + .2, .1, D + .2), mat('#4f7fb0', { roughness: .6 }), 0, ph, 0); roof.userData.park = baseTag;
          const n = Math.max(2, Math.round(W / .7)), bins = cpBinStates(e, n), cpAnims = [];
          const bw = W / n * .6, bh = h * .42, bd = D * .45, t = Math.min(.035, bw * .16, bd * .12);
          for (let i = 0; i < n; i++) {
            const bx = -W / 2 + W * (i + .5) / n, btag = { kind: 'san', id: e.id, part: i };  // 带桶索引的拾取标记：点哪个桶只开哪个桶
            const put = (geo, m, x, y, z) => { const o = P(geo, m, x, y, z); o.userData.park = btag; return o; };
            const shell = mat('#6f7c86', { roughness: .78 });
            // 四壁围成空桶 + 深色底板作内胆；开盖后从上方看到空腔而非实心顶面
            put(new THREE.BoxGeometry(t, bh, bd), shell, bx - bw / 2 + t / 2, bh / 2, D * .12);
            put(new THREE.BoxGeometry(t, bh, bd), shell, bx + bw / 2 - t / 2, bh / 2, D * .12);
            put(new THREE.BoxGeometry(bw - 2 * t, bh, t), shell, bx, bh / 2, D * .12 - bd / 2 + t / 2);
            put(new THREE.BoxGeometry(bw - 2 * t, bh, t), shell, bx, bh / 2, D * .12 + bd / 2 - t / 2);
            put(new THREE.BoxGeometry(bw - 2 * t, t, bd - 2 * t), darkM, bx, t / 2, D * .12);
            const hinge = new THREE.Group(); hinge.position.set(bx, bh, D * .12 - bd / 2); grp.add(hinge);
            const lid = new THREE.Mesh(new THREE.BoxGeometry(bw * .98, .05, bd * .96), mat('#8a939b', { roughness: .62 }));
            lid.position.set(0, .025, bd / 2); lid.castShadow = true; lid.userData.park = btag; hinge.add(lid);
            const a = anim(null, k => { hinge.rotation.x = -k * 1.15; });   // 盖绕后沿上翻：每桶一条独立动画
            a.open = bins[i] === true; a.cur = a.open ? 1 : 0; a.apply(a.cur);
            cpAnims.push(a);
          }
          vis.cpAnims = cpAnims;
          const lm = P(new THREE.SphereGeometry(.08, 12, 8), oneMat(new THREE.MeshBasicMaterial({ color: 0xe5484d })), 0, ph*.82, 0);
          lamp(lm, 0xe5484d, 0x3cc46e); lm.userData.park = baseTag;   // 柱 / 顶棚 / 状态灯无 part：点击切清运状态
          foot(W, D, ph);
        } else if (T3 === 'sanGarbageRoom') {                    // 垃圾房：四壁砌墙 + 前墙真门洞 + 双扇外开门（漫游可进入）
          const t = .12, bh = h * .82, doorH = h * .7, dw = W * .28;
          const wseg = (lx, lz, w2, d2, y1) => {                 // 墙段碰撞：按本地中心 + 尺寸登记 AABB，门洞处不登记
            const q = wp(lx, lz), ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          const wallM = mat('#b8b2a4', { roughness: .82 });
          P(new THREE.BoxGeometry(W, bh, t), wallM, 0, bh / 2, -D / 2);                       // 背墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, -W / 2, bh / 2, 0);                      // 左墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, W / 2, bh / 2, 0);                       // 右墙
          const segL = W / 2 - dw, segR = segL;                                              // 前墙门洞居中、总宽 2*dw，左右各留一段墙垛
          if (segL > .01) P(new THREE.BoxGeometry(segL, bh, t), wallM, -W / 2 + segL / 2, bh / 2, D / 2);
          if (segR > .01) P(new THREE.BoxGeometry(segR, bh, t), wallM, W / 2 - segR / 2, bh / 2, D / 2);
          if (bh > doorH + .05) P(new THREE.BoxGeometry(dw * 2, bh - doorH, t), wallM, 0, doorH + (bh - doorH) / 2, D / 2);  // 门楣
          P(new THREE.BoxGeometry(W + .25, .12, D + .25), mat('#8d949c', { roughness: .7 }), 0, h * .84, 0);   // 屋顶
          [-1, 1].forEach(sd => {                                                            // 双扇对开门：进通用门体系，动画与关门挡人共用一套
            const hinge = new THREE.Group(); hinge.position.set(sd * dw, doorH / 2, D / 2); grp.add(hinge);
            const door = new THREE.Mesh(new THREE.BoxGeometry(dw * .96, doorH - .02, .08), mat('#7b8188', { metalness: .3 }));
            door.position.set(-sd * dw / 2, 0, 0); door.castShadow = true; hinge.add(door);
            door.userData.park = { kind: 'san', id: e.id };                                 // 只有门扇带 park：点门扇才开门
            if (doors) doors.push({ pivot: hinge, a0: 0, a1: sd * 1.9, open: on, cur: on ? sd * 1.9 : 0, len: dw * .96, sanOn: e.id });
          });
          wseg(0, -D / 2, W, t, bh); wseg(-W / 2, 0, t, D, bh); wseg(W / 2, 0, t, D, bh);    // 背 / 左 / 右墙碰撞
          if (segL > .01) wseg(-W / 2 + segL / 2, D / 2, segL, t, bh);                        // 前墙门洞两侧碰撞，门洞处留空可通行
          if (segR > .01) wseg(W / 2 - segR / 2, D / 2, segR, t, bh);
          // 不调用 tag(grp)：房体（墙 / 屋顶 / 门楣）不带 park 标记，点击只经 grp 的 pick3d 选中，不再开门；开门只能点击门扇
        } else if (T3 === 'sanToilet' || T3 === 'sanMobileToilet') { // 公厕 / 移动厕所：四壁留门洞（漫游可进入）+ 蹲位隔墙 + 有人/无人灯
          const mob = T3 === 'sanMobileToilet', bh = h * .9, t = .12;
          const wseg = (lx, lz, w2, d2, y1) => {                     // 旋转墙段碰撞：按本地中心 + 尺寸登记 AABB，门洞处不登记
            const q = wp(lx, lz), ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          const wallM = mat(mob ? '#cdd7df' : '#d3dde5', { roughness:.82 });
          P(new THREE.BoxGeometry(W, bh, t), wallM, 0, bh / 2, -D / 2);                              // 背墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, -W / 2, bh / 2, 0);                             // 左墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, W / 2, bh / 2, 0);                              // 右墙
          const dw = mob ? Math.min(W * .58, .9) : Math.min(W * .34, .8), doorX = -W * .12, doorH = mob ? Math.min(h * .82, bh - .1) : Math.min(h * .62, bh - .1);  // 门洞：前墙偏左；移动厕所房体窄，门单独放大到可通行尺寸
          const segL = doorX - dw / 2 + W / 2, segR = W / 2 - doorX - dw / 2;                      // 前墙门洞左右两段宽度
          if (segL > .01) P(new THREE.BoxGeometry(segL, bh, t), wallM, -W / 2 + segL / 2, bh / 2, D / 2);
          if (segR > .01) P(new THREE.BoxGeometry(segR, bh, t), wallM, W / 2 - segR / 2, bh / 2, D / 2);
          if (bh > doorH + .05) P(new THREE.BoxGeometry(dw, bh - doorH, t), wallM, doorX, doorH + (bh - doorH) / 2, D / 2);  // 门楣
          P(new THREE.BoxGeometry(W + .18, .1, D + .18), mat(mob ? '#5f8fc0' : '#8d949c'), 0, h * .92, 0);                  // 屋顶
          const hinge = new THREE.Group(); hinge.position.set(doorX - dw / 2, 0, D / 2); grp.add(hinge);
          const leaf = new THREE.Mesh(new THREE.BoxGeometry(dw - .03, doorH - .02, .06), mat('#7b8188'));
          leaf.position.set((dw - .03) / 2, (doorH - .02) / 2, 0); leaf.castShadow = true; hinge.add(leaf);
          const sd = { kind: 'sandoor', id: e.id };                                                  // 门扇独立拾取：点击 / 漫游 E 开关门，与切有人/无人灯分开
          leaf.userData.park = sd;
          const doorOpen = e.doorOpen !== false;                                                     // 门默认敞开（可进入），可点击关闭
          if (doors) doors.push({ open: doorOpen, cur: doorOpen ? -1.45 : 0, a0: 0, a1: -1.45, pivot: hinge,
            len: dw - .03, sandoor: e.id, kind: 'san', id: e.id });                               // 通用门体系：动画 + 关门挡人碰撞；开合由 e.doorOpen 同步（a1 取负角 = 绕 Y 负转向本地 +z 外开，门扇露在墙外可点）
          if (!mob) { const n = Math.max(2, Math.round(W / 1.2)); for (let i = 1; i < n; i++) P(new THREE.BoxGeometry(.05, h * .78, D * .7), mat('#aebdc7'), -W/2 + i*W/n, h*.39, -D*.1); }
          const lm = P(new THREE.SphereGeometry(.075, 12, 8), oneMat(new THREE.MeshBasicMaterial({ color: 0x3cc46e })), W * .34, h * .6, D / 2 + .05);
          lamp(lm, 0x3cc46e, 0xe5484d);
          wseg(0, -D / 2, W, t, bh); wseg(-W / 2, 0, t, D, bh); wseg(W / 2, 0, t, D, bh);           // 背 / 左右墙碰撞
          if (segL > .01) wseg(-W / 2 + segL / 2, D / 2, segL, t, bh);                             // 前墙门洞左段碰撞
          if (segR > .01) wseg(W / 2 - segR / 2, D / 2, segR, t, bh);                              // 前墙门洞右段碰撞
          tag(grp);
          leaf.userData.park = sd;                                                                  // tag 会覆盖所有 mesh 的 park 标记，门扇需在之后重打以保留独立开关交互
        } else if (T3 === 'sanWashBasin') {                      // 洗手台：落地柜（门 / 拉手 / 凹踢脚）+ 开洞台面 + 双台下盆 + 弯管龙头 + 背屏镜 + 毛巾 / 皂液器 + 水流
          const woodM = mat('#c6ac86', { roughness: .55 }), woodLt = mat('#d9c8a9', { roughness: .5 });
          const stoneM = mat('#e9e7e1', { roughness: .28, metalness: .06 }), edgeM = mat('#c8c5be', { roughness: .45 });
          const porcM = mat('#fbfbf9', { roughness: .22, side: THREE.DoubleSide });
          const chrome = mat('#e9eef2', { metalness: 1, roughness: .1 }), trimM = mat('#4b5157', { metalness: .4, roughness: .45 });
          const towelM = mat('#f4f1e8', { roughness: .95 }), bottleM = mat('#eae5d8', { roughness: .3 });
          const waterM = oneMat(new THREE.MeshBasicMaterial({ color: 0x74c7f5, transparent: true, opacity: .5, depthWrite: false }));
          const foamM = oneMat(new THREE.MeshBasicMaterial({ color: 0xcdeafd, transparent: true, opacity: .45, side: THREE.DoubleSide, depthWrite: false }));
          // 圆角盒：y 为盒中心（本地件专用，外层 rbox 是 y = 底面）
          const RB = (w2, h2, d2, m, x, yc, z, r = .02) => P(new RoundedBoxGeometry(w2, h2, d2, 2, Math.max(.001, Math.min(r, w2 / 2 - .002, h2 / 2 - .002, d2 / 2 - .002))), m, x, yc, z);

          const yT = h * .8;                                      // 台面顶标高（沿用原 0.8h，标准 800~850）
          const tt = Math.min(.045, Math.max(.022, h * .042));    // 台面厚
          const yTop = yT - tt, yb = Math.max(.05, h * .06);      // 台面底 / 柜体底（踢脚顶）
          const cw = W * .96, cd = D * .84;                       // 柜体宽 / 深

          RB(cw - .1, yb, cd - .08, trimM, 0, yb / 2 + .002, 0, .008);                // 内凹踢脚（深色，底部退进一圈）
          // 柜体做空心：左右侧板 + 背板 + 顶底板 + 中隔板，前脸留给可开合柜门（开门后能看到内腔与盆底存水弯）
          const panT = .018;
          RB(panT, yTop - yb, cd, woodM, -(cw / 2 - panT / 2), (yTop + yb) / 2, 0, .004);
          RB(panT, yTop - yb, cd, woodM, cw / 2 - panT / 2, (yTop + yb) / 2, 0, .004);
          RB(cw - panT * 2, yTop - yb, .012, woodM, 0, (yTop + yb) / 2, -cd / 2 + .006, .004);
          RB(cw - panT * 2, .018, cd - .02, woodM, 0, yTop - .009, 0, .004);          // 顶板
          RB(cw - panT * 2, .018, cd - .02, woodM, 0, yb + .009, 0, .004);            // 底板
          RB(panT, yTop - yb - .05, cd - .04, woodM, 0, (yTop + yb) / 2, 0, .004);    // 中隔板（双盆各一格）
          const dh = (yTop - yb) * .84, dcy = yb + (yTop - yb) * .5, dgap = .006;     // 门高 / 门中心 / 中缝
          const dw2 = (cw * .96 - dgap) / 2, cabOpen = e.cabOpen === true, cabMeshes = [];
          const addTo = (parent, geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; parent.add(o); return o; };
          [-1, 1].forEach(sd => {
            const hinge = new THREE.Group(); hinge.position.set(sd * (cw / 2 - .004), 0, cd / 2); grp.add(hinge);   // 铰链在柜体前缘外侧
            addTo(hinge, new RoundedBoxGeometry(dw2, dh, .018, 2, .005), woodLt, -sd * dw2 / 2, dcy, -.009);          // 门板
            addTo(hinge, new THREE.BoxGeometry(dw2 * .94, dh * .92, .006), woodM, -sd * dw2 / 2, dcy, -.021);         // 门背封边（开门可见）
            const hx = -sd * (dw2 - .078), hy = dcy + dh * .3;                                                       // 拉手随门一起转
            addTo(hinge, new THREE.CylinderGeometry(.008, .008, .13, 10), chrome, hx, hy, .028).rotation.z = Math.PI / 2;
            [-1, 1].forEach(s2 => addTo(hinge, new THREE.CylinderGeometry(.006, .006, .026, 8), chrome, hx + s2 * .065, hy, .019).rotation.x = Math.PI / 2);
            const a1 = sd * 1.75;                                                                                    // 绕外侧铰链向 +z 外开约 100°
            if (doors) doors.push({ open: cabOpen, cur: cabOpen ? a1 : 0, a0: 0, a1, pivot: hinge, len: dw2, kind: 'san', id: e.id, sancab: e.id });
            hinge.traverse(o => { if (o.isMesh) cabMeshes.push(o); });
          });

          // 台面：圆角矩形挤出，按盆位开两个椭圆洞（台下盆从洞下吊装）
          const topW = W * .99, topD = D * .97, tr2 = Math.min(topW, topD) * .05;
          const hw2 = topW / 2, hd2 = topD / 2;
          const sTop = new THREE.Shape();
          sTop.moveTo(-hw2 + tr2, -hd2);
          sTop.lineTo(hw2 - tr2, -hd2); sTop.quadraticCurveTo(hw2, -hd2, hw2, -hd2 + tr2);
          sTop.lineTo(hw2, hd2 - tr2); sTop.quadraticCurveTo(hw2, hd2, hw2 - tr2, hd2);
          sTop.lineTo(-hw2 + tr2, hd2); sTop.quadraticCurveTo(-hw2, hd2, -hw2, hd2 - tr2);
          sTop.lineTo(-hw2, -hd2 + tr2); sTop.quadraticCurveTo(-hw2, -hd2, -hw2 + tr2, -hd2);
          const pr = Math.max(.08, Math.min(W * .17, D * .32)), prz = pr * .78, pz0 = D * .06;   // 盆半径（x / z）/ 盆中心前移量
          const pxs = [-W * .19, W * .19];
          pxs.forEach(fx => { const hole = new THREE.Path(); hole.absellipse(fx, -pz0, pr, prz, 0, Math.PI * 2, true); sTop.holes.push(hole); });
          const topGeo = new THREE.ExtrudeGeometry(sTop, { depth: tt, bevelEnabled: false, curveSegments: 24 });
          topGeo.rotateX(-Math.PI / 2);
          const topMesh = P(topGeo, stoneM, 0, yTop, 0); topMesh.receiveShadow = true;
          P(new THREE.BoxGeometry(topW, .008, .016), edgeM, 0, yTop - .004, hd2 - .006);          // 台前沿滴水线（深色窄条）
          RB(topW, .075, .024, stoneM, 0, yT + .0375, -hd2 + .012, .006);                          // 后挡水条
          // 背屏 + 镜面：立在台面后沿，镜面朝本地 +z（正面）
          const bpW = Math.min(W * .44, topW - .06), bpH = Math.max(.18, Math.min(h * .34, .36));
          RB(bpW, bpH, .032, woodM, 0, yT + bpH / 2, -hd2 + .03, .008);
          const mir = new THREE.Mesh(new THREE.PlaneGeometry(bpW * .82, bpH * .72), mat('#d9e7ec', { metalness: .95, roughness: .05 }));
          mir.position.set(0, yT + bpH / 2, -hd2 + .047); mir.receiveShadow = false; grp.add(mir);
          // 侧挂毛巾：两根支臂 + 横杆 + 垂下的毛巾
          const armX = cw / 2 + .022, armY = yTop - .17;
          [-.12, .12].forEach(z2 => P(new THREE.CylinderGeometry(.007, .007, .05, 8), chrome, cw / 2 + .012, armY, z2).rotation.z = Math.PI / 2);
          P(new THREE.CylinderGeometry(.008, .008, .32, 10), chrome, armX, armY, 0).rotation.x = Math.PI / 2;
          RB(.02, .16, .15, towelM, armX + .014, armY - .08, -.02, .006);
          // 皂液器：瓶身 + 泵管 + 出液嘴
          const sbx = W * .44, sbz = -hd2 * .52;
          P(new THREE.CylinderGeometry(.027, .03, .085, 16), bottleM, sbx, yT + .0425, sbz);
          P(new THREE.CylinderGeometry(.008, .008, .052, 10), chrome, sbx, yT + .111, sbz);
          P(new THREE.CylinderGeometry(.006, .006, .04, 8), chrome, sbx + .018, yT + .133, sbz).rotation.z = Math.PI / 2;

          const bDepth = Math.min(h * .17, .17), waters = [];
          pxs.forEach((fx, i) => {
            const sd = i === 0 ? -1 : 1;
            // 台下盆：旋转体碗形（DoubleSide 让内壁可见），顶沿比洞口大 5% 盖住洞边
            const pts = [[0, 0], [pr * .3, .004], [pr * .62, .022], [pr * .86, .062], [pr * .97, .115], [pr * 1.05, bDepth]];
            const bB = yTop - bDepth;                                                                                 // 盆底标高
            const bowl = new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, y2]) => new THREE.Vector2(Math.max(r, 1e-4), y2)), 32), porcM);
            bowl.position.set(fx, bB, pz0); bowl.castShadow = true; grp.add(bowl);
            P(new THREE.CylinderGeometry(pr * .13, pr * .13, .008, 14), trimM, fx, bB + .007, pz0);                    // 下水器
            P(new THREE.CylinderGeometry(pr * .155, pr * .155, .003, 16), chrome, fx, bB + .0125, pz0);               // 下水口压圈
            // 柜内排水：下水管 + P 型存水弯（柜门打开后可见）
            const trapPts = [[fx, bB - .004, pz0], [fx, bB - .055, pz0], [fx, bB - .085, pz0 - .05], [fx, bB - .052, pz0 - .1], [fx, bB - .03, pz0 - .142]]
              .map(p2 => new THREE.Vector3(p2[0], p2[1], p2[2]));
            const trap = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trapPts, false, 'centripetal'), 18, .016, 8), trimM);
            trap.castShadow = true; grp.add(trap);
            P(new THREE.CylinderGeometry(.027, .027, .022, 12), trimM, fx, bB - .052, pz0);                           // 存水弯活接
            // 龙头：底座 + 立管 + 弯管 + 出水嘴 + 起泡器 + 侧向单柄
            const z0 = -D * .26;
            P(new THREE.CylinderGeometry(.034, .038, .014, 20), chrome, fx, yT + .007, z0);
            P(new THREE.CylinderGeometry(.019, .019, .1, 16), chrome, fx, yT + .064, z0);
            const bendPts = [[fx, yT + .112, z0], [fx, yT + .156, z0], [fx, yT + .177, z0 + .032], [fx, yT + .173, z0 + .078], [fx, yT + .15, z0 + .105]]
              .map(p2 => new THREE.Vector3(p2[0], p2[1], p2[2]));
            const bend = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bendPts, false, 'centripetal'), 24, .0145, 8), chrome);
            bend.castShadow = true; grp.add(bend);
            P(new THREE.CylinderGeometry(.016, .013, .026, 14), chrome, fx, yT + .136, z0 + .105);     // 出水嘴
            P(new THREE.CylinderGeometry(.012, .012, .008, 12), trimM, fx, yT + .12, z0 + .105);       // 起泡器
            P(new THREE.CylinderGeometry(.008, .008, .058, 10), chrome, fx + sd * .046, yT + .021, z0).rotation.z = Math.PI / 2;   // 手柄连接杆
            const h1 = new THREE.Vector3(fx + sd * .072, yT + .022, z0), h2v = new THREE.Vector3(fx + sd * .105, yT + .058, z0 + .012);
            const handle = new THREE.Mesh(new THREE.CylinderGeometry(.009, .009, h1.distanceTo(h2v), 10), chrome);
            handle.position.copy(h1).add(h2v).multiplyScalar(.5);
            handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), h2v.clone().sub(h1).normalize());
            handle.castShadow = true; grp.add(handle);                                                // 侧向单柄（斜向上，左右盆朝外）
            // 水流：水柱 + 盆底涟漪 + 溅珠（整组 visible 由 applyParkVisual 按 on 控制）
            const spY = yT + .118, spZ = z0 + .105, bowlBottom = bB;
            const wg = new THREE.Group(); wg.visible = on; grp.add(wg);
            const wlen = Math.max(.04, spY - bowlBottom);
            const jet = new THREE.Mesh(new THREE.CylinderGeometry(.0055, .009, wlen, 10), waterM);
            jet.position.set(fx, bowlBottom + wlen / 2, spZ); jet.castShadow = false; wg.add(jet);
            const rip = new THREE.Mesh(new THREE.RingGeometry(.014, .052, 22), foamM);
            rip.rotation.x = -Math.PI / 2; rip.position.set(fx, bowlBottom + .014, spZ); wg.add(rip);
            [[-.05, .022], [.042, -.028], [-.018, -.048]].forEach(([dx2, dz2], k) => {
              const drop = new THREE.Mesh(new THREE.SphereGeometry(.0085, 8, 6), foamM);
              drop.position.set(fx + dx2, bowlBottom + .022 + k * .01, spZ + dz2); wg.add(drop);
            });
            waters.push(wg);
          });
          vis.water = waters; tag(grp);
          cabMeshes.forEach(o => { o.userData.park = { kind: 'sancab', id: e.id }; });   // tag 会覆盖所有 mesh 的 park 标记，柜门（含拉手）需在之后重打以保留独立开合
          small(0, 0, Math.max(W, D) / 2, Math.min(h, 1));
        } else if (T3 === 'sanToolCabinet') {                     // 环卫工具柜：四壁留真门洞（开门见内腔）+ 前侧双扇外开门
          const t = .06, bh = h * .94, doorH = h * .86, dw = W * .48;
          const wseg = (lx, lz, w2, d2, y1) => {                 // 墙段碰撞：按本地中心 + 尺寸登记 AABB，门洞处不登记
            const q = wp(lx, lz), ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          const wallM = mat('#b9c2c9', { roughness: .82 });
          P(new THREE.BoxGeometry(W, bh, t), wallM, 0, bh / 2, -D / 2);                       // 背墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, -W / 2, bh / 2, 0);                      // 左墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, W / 2, bh / 2, 0);                       // 右墙
          const segL = W / 2 - dw, segR = segL;                                              // 前墙门洞居中、总宽 2*dw，左右各留一段墙垛
          if (segL > .01) P(new THREE.BoxGeometry(segL, bh, t), wallM, -W / 2 + segL / 2, bh / 2, D / 2);
          if (segR > .01) P(new THREE.BoxGeometry(segR, bh, t), wallM, W / 2 - segR / 2, bh / 2, D / 2);
          if (bh > doorH + .05) P(new THREE.BoxGeometry(dw * 2, bh - doorH, t), wallM, 0, doorH + (bh - doorH) / 2, D / 2);  // 门楣
          [-1, 1].forEach(sd => {                                                            // 双扇对开门：铰链在门洞两端、门扇向中线合拢，开时向两侧外张（不在门口交叉）
            const hinge = new THREE.Group(); hinge.position.set(sd * dw, doorH / 2, D / 2); grp.add(hinge);
            const door = new THREE.Mesh(new THREE.BoxGeometry(dw * .98, doorH - .02, .06), mat('#a7b1b9', { metalness: .3 }));
            door.position.set(-sd * dw / 2, 0, 0); hinge.add(door);
            door.userData.park = { kind: 'san', id: e.id };                                 // 只有门扇带 park：点门扇才开门
            if (doors) doors.push({ pivot: hinge, a0: 0, a1: sd * 1.75, open: on, cur: on ? sd * 1.75 : 0, len: dw * .98, sanOn: e.id });
          });
          wseg(0, -D / 2, W, t, bh); wseg(-W / 2, 0, t, D, bh); wseg(W / 2, 0, t, D, bh);    // 背 / 左 / 右墙碰撞
          if (segL > .01) wseg(-W / 2 + segL / 2, D / 2, segL, t, bh);                        // 前墙门洞两侧碰撞，门洞处留空
          if (segR > .01) wseg(W / 2 - segR / 2, D / 2, segR, t, bh);
          // 不调用 tag(grp)：柜体不带 park 标记，点击只选中，不再开门；开门只能点击门扇
        } else if (T3 === 'sanWaterPoint') {                      // 洒水取水点：底座 + 阀体 + 出水口 + 水流
          P(new THREE.CylinderGeometry(.1, .13, .18, 10), mat('#8d949c'), 0, .09, 0);
          P(new THREE.CylinderGeometry(W*.42, W*.46, h*.8, 12), mat('#5f8fc0', { metalness: .4 }), 0, h*.5, 0);
          P(new THREE.BoxGeometry(W*.9, .05, .05), steel, 0, h*.78, 0);
          P(new THREE.CylinderGeometry(.05, .05, W*.7, 8), steel, 0, h*.55, D*.3).rotation.x = Math.PI/2;
          const wm = new THREE.Mesh(new THREE.CylinderGeometry(.025, .04, h*.4, 8), oneMat(new THREE.MeshBasicMaterial({ color: 0x59b6ef, transparent: true, opacity: .8 })));
          wm.position.set(0, h*.28, D*.65); wm.visible = on; grp.add(wm); vis.water = [wm];
          const lm = lamp(P(new THREE.SphereGeometry(.04, 10, 8), oneMat(new THREE.MeshBasicMaterial({ color: 0xcf4b42 })), 0, h*.9, 0), 0xcf4b42, 0x3cc46e);
          tag(grp); small(0, 0, Math.max(W, D)/2, Math.min(h, 1.4));
        } else if (T3 === 'sanTransferStation') {                 // 垃圾转运站：空心站体（前墙大开口看进站内）+ 卸料斗列 + 压缩机 + 状态灯
          const bh = h * .8, t = .12, dw = Math.min(W * .5, 3), doorH = Math.min(bh * .72, 2.8);
          const wallM = mat('#c3cad1', { roughness: .82 });
          const wseg = (lx, lz, w2, d2, y1) => {                 // 墙段碰撞：按本地中心 + 尺寸登记 AABB，前墙开口处留空可进
            const q = wp(lx, lz), ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          P(new THREE.BoxGeometry(W - .1, .08, D - .1), mat('#9aa1a8', { roughness: .95 }), 0, .04, 0);   // 站内混凝土地坪
          P(new THREE.BoxGeometry(W, bh, t), wallM, 0, bh / 2, -D / 2);                                    // 背墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, -W / 2, bh / 2, 0);                                   // 左墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, W / 2, bh / 2, 0);                                    // 右墙
          const segL = (W - dw) / 2;                                                                       // 前墙大开口：两侧墙垛 + 门楣
          if (segL > .01) { P(new THREE.BoxGeometry(segL, bh, t), wallM, -(W + dw) / 4, bh / 2, D / 2); P(new THREE.BoxGeometry(segL, bh, t), wallM, (W + dw) / 4, bh / 2, D / 2); }
          if (bh > doorH + .05) P(new THREE.BoxGeometry(dw, bh - doorH, t), wallM, 0, doorH + (bh - doorH) / 2, D / 2);
          P(new THREE.BoxGeometry(W + .3, .14, D + .3), mat('#8d949c'), 0, h * .82, 0);                    // 屋顶
          const n = Math.max(2, Math.round(W / 1.8)), bw = W / n * .62, hopH = h * .3, hopD = D * .32, hopZ = -D * .26;
          const hopM = mat('#b9c4cd', { roughness: .72 }), hopIn = mat('#5b6772', { roughness: .9 });
          for (let i = 0; i < n; i++) {                                                                   // 卸料斗列靠背墙：浅色斗壁 + 深色内腔 + 半高前挡板 + 黄警示条，看得出是倒垃圾的口
            const bx = -W / 2 + W * (i + .5) / n;
            P(new THREE.BoxGeometry(bw, .05, hopD), hopIn, bx, .03, hopZ);                 // 斗底（深色内腔）
            P(new THREE.BoxGeometry(.05, hopH, hopD), hopM, bx - bw / 2, hopH / 2, hopZ);  // 左斗壁
            P(new THREE.BoxGeometry(.05, hopH, hopD), hopM, bx + bw / 2, hopH / 2, hopZ);  // 右斗壁
            P(new THREE.BoxGeometry(bw, hopH, .05), hopM, bx, hopH / 2, hopZ - hopD / 2);  // 后斗壁
            P(new THREE.BoxGeometry(bw, hopH * .42, .05), hopM, bx, hopH * .21, hopZ + hopD / 2); // 半高前挡板，露出斗内
            P(new THREE.BoxGeometry(bw + .06, .06, .08), mat('#e8b44a'), bx, hopH + .03, hopZ - hopD / 2); // 上沿黄警示条
          }
          P(new THREE.BoxGeometry(W*.3, h*.5, D*.35), mat('#6f7c86', { metalness: .3 }), W*.22, h*.25, D*.18);   // 压缩机：站内前部开口一侧，透过开口可见
          const lm = lamp(P(new THREE.SphereGeometry(.09, 12, 8), oneMat(new THREE.MeshBasicMaterial({ color: 0xe8b44a })), 0, h*.7, D/2+.05), 0xe8b44a, 0x3cc46e);
          wseg(0, -D / 2, W, t, bh); wseg(-W / 2, 0, t, D, bh); wseg(W / 2, 0, t, D, bh);                  // 背 / 左 / 右墙碰撞
          if (segL > .01) { wseg(-(W + dw) / 4, D / 2, segL, t, bh); wseg((W + dw) / 4, D / 2, segL, t, bh); }   // 前墙开口两侧碰撞，开口处留空
          wseg(0, hopZ, W * .94, hopD + .08, hopH); wseg(W * .22, D * .18, W * .3, D * .35, h * .5);       // 站内卸料斗列 / 压缩机碰撞：只挡设备、不整体占地，前墙开口可走进站内
          tag(grp);
        } else if (T3 === 'sanRecycleStation') {                  // 再生资源回收站：四壁 + 前墙三真投递洞（各自翻盖、可见站内）+ 背墙双扇门 + 分类标识 + 招牌
          const t = .12, bh = h * .82, doorH = h * .72, dw = W * .46;
          const cols = ['#2f7fd0', '#cf4b42', '#3f9d5c'], names = ['可回收物', '有害垃圾', '厨余垃圾'];
          const pw = W / 3 * .5, ph = h * .17, px2s = cols.map((_, i) => -W / 2 + W * (i + .5) / 3), py = h * .38;   // 洞中心落到腰胸高度（默认约 1.14m）
          const portY0 = py - ph / 2, portY1 = py + ph / 2;                                   // 投递洞上下沿
          const wseg = (lx, lz, w2, d2, y1) => {                 // 墙段碰撞：按本地中心 + 尺寸登记 AABB，洞口处不登记
            const q = wp(lx, lz), ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          const wallM = mat('#d3e3d8', { roughness: .82 });
          // 前墙分段：三投递洞之间的墙垛 + 洞上 / 洞下横墙（洞内是通的，看得见站里）
          const edges = [-W / 2]; px2s.forEach(x => edges.push(x - pw / 2, x + pw / 2)); edges.push(W / 2);
          if (portY0 > .01) P(new THREE.BoxGeometry(W, portY0, t), wallM, 0, portY0 / 2, D / 2);
          if (bh > portY1 + .01) P(new THREE.BoxGeometry(W, bh - portY1, t), wallM, 0, portY1 + (bh - portY1) / 2, D / 2);
          for (let k = 0; k + 1 < edges.length; k += 2) { const a = edges[k], b = edges[k + 1];
            if (b - a > .01) { P(new THREE.BoxGeometry(b - a, portY1 - portY0, t), wallM, (a + b) / 2, py, D / 2); wseg((a + b) / 2, D / 2, b - a, t, bh); }
          }
          P(new THREE.BoxGeometry(t, bh, D), wallM, -W / 2, bh / 2, 0);                      // 左墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, W / 2, bh / 2, 0);                       // 右墙
          const segL = W / 2 - dw, segR = segL;                                              // 背墙门洞：两侧墙垛 + 门楣
          if (segL > .01) P(new THREE.BoxGeometry(segL, bh, t), wallM, -W / 2 + segL / 2, bh / 2, -D / 2);
          if (segR > .01) P(new THREE.BoxGeometry(segR, bh, t), wallM, W / 2 - segR / 2, bh / 2, -D / 2);
          if (bh > doorH + .05) P(new THREE.BoxGeometry(dw * 2, bh - doorH, t), wallM, 0, doorH + (bh - doorH) / 2, -D / 2);
          // 屋顶：加厚 + 四周挑檐 + 顶沿压条
          P(new THREE.BoxGeometry(W + .5, .12, D + .5), mat('#5f9d6f'), 0, h * .85, 0);
          P(new THREE.BoxGeometry(W + .62, .05, D + .62), mat('#4a8159'), 0, h * .92, 0);
          // 前墙顶招牌：绿底白字「再生资源回收站」
          const signT = parkTex('recycleSign', W, h * .12, (g, cw, ch) => {
            g.fillStyle = '#2f7a45'; g.fillRect(0, 0, cw, ch);
            g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.font = `bold ${Math.round(ch * .66)}px "Microsoft YaHei", sans-serif`;
            const txt = '再生资源回收站', tw = g.measureText(txt).width, maxW = cw * .9;
            if (tw > maxW) { const fs = Math.max(10, Math.floor(ch * .66 * maxW / tw)); g.font = `bold ${fs}px "Microsoft YaHei", sans-serif`; }
            g.fillText(txt, cw / 2, ch / 2);
          });
          const sign = new THREE.Mesh(new THREE.PlaneGeometry(W * .92, h * .12), oneMat(new THREE.MeshBasicMaterial({ map: signT, transparent: true })));
          sign.position.set(0, bh + h * .055, D / 2 + .07); grp.add(sign);
          // 三色投递槽 + 分类标牌 + 独立翻盖
          const ports = sanPortStates(e), portAnims = [], portMeshes = [[], [], []];
          cols.forEach((col, i) => {
            const px2 = px2s[i], pd = D * .3, pz = D / 2 + .02, shell = mat(col, { roughness: .82 });
            const put = (geo, m, x, y, z) => { const o = P(geo, m, x, y, z); portMeshes[i].push(o); return o; };
            const wt = Math.min(.035, pw * .06);
            put(new THREE.BoxGeometry(wt, ph, pd), shell, px2 - pw / 2 + wt / 2, py, pz);                 // 槽左壁
            put(new THREE.BoxGeometry(wt, ph, pd), shell, px2 + pw / 2 - wt / 2, py, pz);                 // 槽右壁
            put(new THREE.BoxGeometry(pw - 2 * wt, wt, pd), shell, px2, py - ph / 2 + wt / 2, pz);        // 槽底板（通到站内的浅托盘，非实心）
            // 分类标牌：槽上方色底白字，如「可回收物」
            const tagT = parkTex('recycleTag' + i, pw, ph * .5, (g, cw, ch) => {
              g.fillStyle = col; g.fillRect(0, 0, cw, ch);
              g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
              g.font = `bold ${Math.round(ch * .7)}px "Microsoft YaHei", sans-serif`;
              const tw = g.measureText(names[i]).width, maxW = cw * .92;
              if (tw > maxW) { const fs = Math.max(10, Math.floor(ch * .7 * maxW / tw)); g.font = `bold ${fs}px "Microsoft YaHei", sans-serif`; }
              g.fillText(names[i], cw / 2, ch / 2);
            });
            const tagM = new THREE.Mesh(new THREE.PlaneGeometry(pw * .92, ph * .5), oneMat(new THREE.MeshBasicMaterial({ map: tagT, transparent: true })));
            tagM.position.set(px2, portY1 + ph * .34, D / 2 + .075); grp.add(tagM); portMeshes[i].push(tagM);
            // 前盖：铰链在投递口下沿外侧、关闭时竖直封口，开启向外下方翻开（保持原有开前盖方式）
            const frontHinge = new THREE.Group(); frontHinge.position.set(px2, portY0, pz + pd / 2); grp.add(frontHinge);
            const frontLid = new THREE.Mesh(new THREE.BoxGeometry(pw * .96, ph * .94, .05), mat(col, { roughness: .6 }));
            frontLid.position.set(0, ph * .47, 0); frontLid.castShadow = true; frontHinge.add(frontLid); portMeshes[i].push(frontLid);
            // 上盖：铰链在前墙外侧的洞口上沿、盖体位于铰链下侧，关闭时水平挑出盖住槽顶，开启向上外掀（< 90°，全程 z 不小于铰链、绝不倒回墙里）
            const topHinge = new THREE.Group(); topHinge.position.set(px2, portY1, D / 2 + .09); grp.add(topHinge);
            const topLid = new THREE.Mesh(new THREE.BoxGeometry(pw * .96, .05, pd * .6), mat(col, { roughness: .6 }));
            topLid.position.set(0, -.025, pd * .3); topLid.castShadow = true; topHinge.add(topLid); portMeshes[i].push(topLid);
            const a = anim(null, k => {                                                       // 一口一条动画：前盖向外下翻，上盖向上翻起，共用该口 ports[i] 状态
              frontHinge.rotation.x = k * 1.5;
              topHinge.rotation.x = -k * 1.3;
            });
            a.open = ports[i] === true; a.cur = a.open ? 1 : 0; a.apply(a.cur);
            portAnims.push(a);
          });
          vis.portAnims = portAnims;
          [-1, 1].forEach(sd => {                                                            // 背墙双扇对开门：铰链在门洞两端、门扇向中线合拢，开时向两侧外张（不在门口交叉）
            const hinge = new THREE.Group(); hinge.position.set(sd * dw, doorH / 2, -D / 2); grp.add(hinge);
            const door = new THREE.Mesh(new THREE.BoxGeometry(dw * .98, doorH - .02, .06), mat('#a7b1b9', { metalness: .3 }));
            door.position.set(-sd * dw / 2, 0, 0); hinge.add(door);
            door.userData.park = { kind: 'san', id: e.id };                                 // 只有背墙门扇带 park：点门扇才开门
            if (doors) doors.push({ pivot: hinge, a0: 0, a1: -sd * 1.7, open: on, cur: on ? -sd * 1.7 : 0, len: dw * .98, sanOn: e.id });
          });
          wseg(-W / 2, 0, t, D, bh); wseg(W / 2, 0, t, D, bh);                               // 左 / 右墙碰撞
          if (segL > .01) wseg(-W / 2 + segL / 2, -D / 2, segL, t, bh);                      // 背墙门洞两侧碰撞，门洞处留空
          if (segR > .01) wseg(W / 2 - segR / 2, -D / 2, segR, t, bh);
          // 不调用 tag(grp)：站体（墙 / 屋顶 / 招牌）不带 park 标记，点击只选中，不再开门；开门只能点背墙门扇
          portMeshes.forEach((ms, i) => { ms.forEach(o => { o.userData.park = { kind: 'san', id: e.id, part: i }; }); });  // 三口的壁 / 标牌 / 前盖 / 上盖按口打 part，保留各自独立投放开合
        } else if (T3 === 'sanRestRoom') {                        // 环卫休息室：四壁留真窗洞 + 前墙门洞（漫游可进入）+ 门扇可开合 + 室内吸顶灯 + 门边开关
          const bh = h * .9, t = .12;
          const wseg = (lx, lz, w2, d2, y1) => {                     // 旋转墙段碰撞：按本地中心 + 尺寸登记 AABB，门洞处不登记
            const q = wp(lx, lz), ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          const wallM = mat('#d7d0c2', { roughness: .82 });
          const sill = Math.max(.7, Math.min(1, bh * .38)), winH = Math.min(1.25, bh - sill - .12), winTop = sill + winH;   // 窗台 / 窗洞高：随房高伸缩，确保不顶屋顶
          const winW = Math.min(1.3, W * .36), wx = -W * .3, winL = wx - winW / 2, winR = wx + winW / 2;                    // 窗洞宽 / 中心 x：偏左，与前墙门洞分开
          const wallWin = (x0, x1, zc) => {                        // 沿 x 建一面带真窗洞的墙：左右墙垛 + 窗下墙 + 窗上墙（窗洞处不填墙）
            const sg = (a, b, y0, y1) => { if (b - a > .01 && y1 - y0 > .01) P(new THREE.BoxGeometry(b - a, y1 - y0, t), wallM, (a + b) / 2, (y0 + y1) / 2, zc); };
            sg(x0, winL, 0, bh); sg(winR, x1, 0, bh); sg(winL, winR, 0, sill); sg(winL, winR, winTop, bh);
          };
          wallWin(-W / 2, W / 2, -D / 2);                                                            // 背墙（带窗洞）
          P(new THREE.BoxGeometry(t, bh, D), wallM, -W / 2, bh / 2, 0);                             // 左墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, W / 2, bh / 2, 0);                              // 右墙
          const dw = Math.min(W * .34, .9), doorX = W * .16, doorH = Math.min(h * .62, bh - .1);   // 门洞：前墙偏右
          const segL = doorX - dw / 2 + W / 2, segR = W / 2 - doorX - dw / 2;                      // 前墙门洞左右两段宽度
          if (segL > .01) wallWin(-W / 2, doorX - dw / 2, D / 2);                                   // 前墙左段（带窗洞）
          if (segR > .01) P(new THREE.BoxGeometry(segR, bh, t), wallM, W / 2 - segR / 2, bh / 2, D / 2);
          if (bh > doorH + .05) P(new THREE.BoxGeometry(dw, bh - doorH, t), wallM, doorX, doorH + (bh - doorH) / 2, D / 2);  // 门楣
          P(new THREE.BoxGeometry(W + .2, .12, D + .2), mat('#a89f8e'), 0, h * .94, 0);             // 屋顶
          P(new THREE.BoxGeometry(W * .5, .07, D * .24), mat('#b08d5f', { roughness: .7 }), 0, .24, -D / 2 + D * .18);       // 靠背墙长凳：凳面
          P(new THREE.BoxGeometry(W * .5, .3, .06), mat('#b08d5f', { roughness: .7 }), 0, .4, -D / 2 + D * .3);              // 凳背
          const frameM = mat('#eceae3', { roughness: .5, metalness: .15 });                         // 窗框浅色铝材
          const glsM = oneMat(new THREE.MeshPhysicalMaterial({ color: 0xa8c6d6, roughness: .1, metalness: .05, transparent: true, opacity: .32, side: THREE.DoubleSide, depthWrite: false }));
          [1, -1].forEach(out => {                                  // 前 / 背墙各一扇真窗：out = 室外法向（+z / −z）
            const zc = out > 0 ? D / 2 : -D / 2, cy = sill + winH / 2, zf = zc + out * (t / 2 + .012);
            const bar = (w2, h2, d2, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2), m || frameM); b.position.set(x, y, z); b.castShadow = true; grp.add(b); };
            bar(winW + .06, .05, .09, wx, sill, zf); bar(winW + .06, .05, .09, wx, winTop, zf);    // 下 / 上框
            bar(.05, winH, .09, winL, cy, zf); bar(.05, winH, .09, winR, cy, zf);                   // 左 / 右框
            bar(.035, winH, .07, wx, cy, zf); bar(winW, .03, .07, wx, cy, zf);                      // 中竖梃 + 中横梃：十字分格
            const pane = new THREE.Mesh(new THREE.BoxGeometry(winW - .05, winH - .05, .012), glsM);  // 半透明玻璃：纯反光，不再发光
            pane.position.set(wx, cy, zf - out * .02); grp.add(pane);
            bar(winW + .16, .035, .18, wx, sill - .03, zf + out * .05, mat('#b9b3a5', { roughness: .8 }));  // 外窗台板
          });
          // 吸顶灯：室内顶棚中央的灯座 + 乳白灯罩 + 发光灯泡 + 真实点光源，随 on 亮 / 灭（取代原窗户假灯光）
          const lampGrp = new THREE.Group(); lampGrp.position.set(0, bh - .05, 0); grp.add(lampGrp);
          const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(.14, .14, .035, 16), mat('#aab0b5', { metalness: .35, roughness: .5 }));
          lampGrp.add(lampBase);
          const lampShade = new THREE.Mesh(new THREE.CylinderGeometry(.1, .2, .12, 18, 1, true), mat('#f4f1e8', { roughness: .55, side: THREE.DoubleSide }));
          lampShade.position.y = -.075; lampGrp.add(lampShade);
          const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd98a, emissiveIntensity: on ? 1.2 : .05, roughness: .35 });
          bulbMat.userData.lampRef = e; lampGlowMats.push(bulbMat);           // 接入全局灯光：refOn(e) 按 e.on 控制 emissive，白天 / 夜景都亮
          const bulb = new THREE.Mesh(new THREE.SphereGeometry(.1, 16, 12), bulbMat);
          bulb.position.y = -.12; lampGrp.add(bulb);
          if (lampG.children.filter(o => o.isPointLight).length < 28) {       // 真实照明：与自建灯具同一光源池 / 上限，by on 点亮室内（applyLight 按 e.on 刷 intensity）
            const pl = new THREE.PointLight(0xffd9a8, 0, Math.max(2.5, W * 1.1), 1.5);
            pl.position.set(px, bh - .22, pz); pl.userData.lampRef = e; lampG.add(pl);
          }
          // 门边开关：前墙门洞左侧墙垛室内面，带状态小灯；独立拾取 sanSwitch，点击 / 漫游 E 切灯
          const swTag = { kind: 'sanSwitch', id: e.id }, swY = Math.min(1.25, bh - .2);
          const swX = doorX - dw / 2 - Math.min(.18, Math.max(.1, segL * .12)), swZ = D / 2 - t / 2 - .012;
          const swPanel = new THREE.Mesh(new THREE.BoxGeometry(.1, .14, .022), mat('#f0eee8', { roughness: .6 }));
          swPanel.position.set(swX, swY, swZ); grp.add(swPanel);
          const swBtn = new THREE.Mesh(new THREE.BoxGeometry(.055, .075, .024), oneMat(new THREE.MeshBasicMaterial({ color: on ? 0x3cc46e : 0xcf4b42 })));
          swBtn.position.set(swX, swY, swZ - .014); grp.add(swBtn);
          vis.lamps.push({ mesh: swBtn, offHex: 0xcf4b42, onHex: 0x3cc46e });
          swPanel.userData.park = swTag; swBtn.userData.park = swTag;   // 开关独立于房体：点击只切灯
          const hinge = new THREE.Group(); hinge.position.set(doorX - dw / 2, 0, D / 2); grp.add(hinge);
          const leaf = new THREE.Mesh(new THREE.BoxGeometry(dw - .03, doorH - .02, .06), mat('#7b8188'));
          leaf.position.set((dw - .03) / 2, (doorH - .02) / 2, 0); leaf.castShadow = true; hinge.add(leaf);
          const sd = { kind: 'sandoor', id: e.id };                                                  // 门扇独立拾取：点击 / 漫游 E 开关门，与切灯分开
          leaf.userData.park = sd;
          const doorOpen = e.doorOpen !== false;                                                     // 门默认敞开（可进入），可点击关闭
          if (doors) doors.push({ open: doorOpen, cur: doorOpen ? -1.45 : 0, a0: 0, a1: -1.45, pivot: hinge,
            len: dw - .03, sandoor: e.id, kind: 'san', id: e.id });                               // 通用门体系：动画 + 关门挡人碰撞；开合由 e.doorOpen 同步（与公厕门同为本地 +z 外开）
          wseg(0, -D / 2, W, t, bh); wseg(-W / 2, 0, t, D, bh); wseg(W / 2, 0, t, D, bh);           // 背 / 左右墙碰撞
          if (segL > .01) wseg(-W / 2 + segL / 2, D / 2, segL, t, bh);                             // 前墙门洞左段碰撞
          if (segR > .01) wseg(W / 2 - segR / 2, D / 2, segR, t, bh);                              // 前墙门洞右段碰撞
          // 不调用 tag(grp)：房体（墙 / 屋顶 / 窗）不带 park 标记，点击只经 grp 的 pick3d 选中，不再切灯；切灯只走门边开关
        }
      }
      /* 垃圾转运站 8 件 3D 建模：主体车间（卷帘门开合）+ 卸料槽 / 压缩机（运行推杆）/ 勾臂转运箱（开盖）/
         汽车地磅 / 除臭喷淋（水雾开关）/ 污水收集池 / 洗车台。可交互件整体打 park={kind:'wt'} 标记，
         动画态进 parkAnims / wtRuns，灯色与水雾由 applyParkVisual 按 e.on 统一刷新。 */
      function buildWt3D(T3, e, ctx, visuals, runs, anims, oneMat, mat, parkTex, txtTex) {
        const { grp, P, colliders, px, pz, ang, W, h, poleM, darkM } = ctx;
        const D = Math.max(.2, M(e.d || 1200)), on = e.on === true;
        const ca = Math.cos(ang), sa = Math.sin(ang), wp = (lx, lz) => [px + lx * ca - lz * sa, pz + lx * sa + lz * ca];
        const foot = (w2, d2, y1) => { const ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2; colliders.push([px - ww, pz - dd, px + ww, pz + dd, 0, y1]); };
        const small = (lx, lz, r, y1) => { const q = wp(lx, lz); colliders.push([q[0] - r, q[1] - r, q[0] + r, q[1] + r, 0, y1]); };
        const steelM = mat('#9aa1a8', { metalness: .5, roughness: .5 });
        const vis = { kind: T3, lamps: [], lids: [], mists: [], runs: [] };
        visuals.set(String(e.id), vis);
        const tag = o => { o.traverse(x => { if (x.isMesh) x.userData.park = { kind: 'wt', id: e.id }; }); return o; };
        const lamp = (mesh, offHex, onHex) => {
          mesh.material = oneMat(new THREE.MeshBasicMaterial({ color: on ? onHex : offHex }));
          vis.lamps.push({ mesh, onHex, offHex }); return mesh;
        };
        const anim = applyFn => {
          const a = { id: e.id, kind: 'wt', open: on, cur: on ? 1 : 0, apply: applyFn };
          anims.push(a); a.apply(a.cur); return a;
        };

        if (T3 === 'wtStation') {                               // 转运车间：砖墙 + 前墙卷帘门洞（门帘整体开合动画）+ 双坡彩钢屋顶 + 山墙 + 站牌
          const bh = h, t = .15, dw = Math.min(W * .5, 4), doorH = Math.min(bh * .72, 4.5);
          const wallM = mat('#c8c2b4', { roughness: .82 });
          const wseg = (lx, lz, w2, d2, y1) => {
            const q = wp(lx, lz), ww = (w2 * Math.abs(ca) + d2 * Math.abs(sa)) / 2, dd = (w2 * Math.abs(sa) + d2 * Math.abs(ca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          P(new THREE.BoxGeometry(W - .1, .08, D - .1), mat('#9a948a', { roughness: .95 }), 0, .04, 0);   // 室内混凝土地坪
          P(new THREE.BoxGeometry(W, bh, t), wallM, 0, bh / 2, -D / 2);                                    // 背墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, -W / 2, bh / 2, 0);                                   // 左墙
          P(new THREE.BoxGeometry(t, bh, D), wallM, W / 2, bh / 2, 0);                                    // 右墙
          const segL = (W - dw) / 2;                                                                       // 前墙门洞两侧墙垛 + 门楣
          if (segL > .01) { P(new THREE.BoxGeometry(segL, bh, t), wallM, -(W + dw) / 4, bh / 2, D / 2); P(new THREE.BoxGeometry(segL, bh, t), wallM, (W + dw) / 4, bh / 2, D / 2); }
          if (bh > doorH + .05) P(new THREE.BoxGeometry(dw, bh - doorH, t), wallM, 0, doorH + (bh - doorH) / 2, D / 2);
          // 双坡彩钢屋顶：屋脊沿车间纵向，两侧坡面下探到檐口
          const rise = Math.min(1.8, D * .22), sl = Math.hypot(D / 2, rise), ra = Math.atan2(rise, D / 2);
          [-1, 1].forEach(sd => {
            const r = P(new THREE.BoxGeometry(W + .3, .1, sl + .15), mat('#7f97ab', { roughness: .5, metalness: .25 }), 0, bh + rise / 2 + .05, sd * D / 4);
            r.rotation.x = sd * ra;
          });
          // 山墙三角封檐（两端）
          [-1, 1].forEach(sd => {
            const sh = new THREE.Shape(); sh.moveTo(-D / 2, 0); sh.lineTo(D / 2, 0); sh.lineTo(0, rise); sh.closePath();
            const g = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false }), wallM);
            g.rotation.y = -Math.PI / 2; g.position.set(sd > 0 ? W / 2 - t : -W / 2, bh, 0);
            g.castShadow = g.receiveShadow = true; grp.add(g);
          });
          // 电动卷帘门：分条门帘沿门洞整幅升降
          const doorG = new THREE.Group(); doorG.position.set(0, 0, D / 2 - t / 2 - .04); grp.add(doorG);
          const slats = Math.max(6, Math.round(doorH / .35)), sh2 = doorH / slats;
          for (let i = 0; i < slats; i++) {
            const sl = new THREE.Mesh(new THREE.BoxGeometry(dw - .06, sh2 - .02, .06), mat(i % 2 ? '#9fb2c2' : '#8fa3b4', { metalness: .3, roughness: .5 }));
            sl.position.set(0, sh2 * (i + .5), 0); sl.castShadow = true; doorG.add(sl);
          }
          doorG.traverse(x => { if (x.isMesh) x.userData.park = { kind: 'wt', id: e.id }; });
          vis.lids.push(anim(k => { doorG.position.y = k * (doorH - .04); }));
          // 站牌：山墙正面 Canvas 贴图（站名 + 日转运量），面板改转运量重建后同步
          const ton = Math.round(e.ton || 60), signW = Math.min(4.5, W * .42), signH = signW * .26;
          P(new THREE.BoxGeometry(signW + .12, signH + .12, .08), mat('#1e5c38', { roughness: .6 }), 0, bh + rise * .45, D / 2 + t / 2 + .02);
          const face = new THREE.Mesh(new THREE.PlaneGeometry(signW, signH), oneMat(new THREE.MeshBasicMaterial({ map: txtTex('wtSign' + e.id + '_' + ton, Math.round(signW * 1000), Math.round(signH * 1000), `垃圾转运站 ${ton} t/日`, '#1e5c38', '#ffffff'), toneMapped: false })));
          face.position.set(0, bh + rise * .45, D / 2 + t / 2 + .07); face.castShadow = false; grp.add(face);
          wseg(0, -D / 2, W, t, bh); wseg(-W / 2, 0, t, D, bh); wseg(W / 2, 0, t, D, bh);                 // 背 / 左 / 右墙碰撞
          if (segL > .01) { wseg(-(W + dw) / 4, D / 2, segL, t, bh); wseg((W + dw) / 4, D / 2, segL, t, bh); }   // 前墙门洞两侧碰撞，门洞留空可进出
          tag(grp);                                                                                         // 站体整体可点击：点击任意部位切卷帘门
        } else if (T3 === 'wtHopper') {                         // 卸料槽：钢柱 + 抬高台面 + 后挡料墙 + 侧壁 + 中心投料口 + 前引坡
          const deckH = Math.max(.6, h * .8);
          [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz]) => P(new THREE.BoxGeometry(.16, deckH, .16), steelM, sx * (W / 2 - .15), deckH / 2, sz * (D / 2 - .15)));
          P(new THREE.BoxGeometry(W, .18, D), mat('#b5b0a3', { roughness: .95 }), 0, deckH + .09, 0);      // 混凝土台面
          P(new THREE.BoxGeometry(W, h, .22), mat('#a8a294', { roughness: .9 }), 0, deckH + h / 2, -D / 2 + .11);   // 后挡料墙
          [-1, 1].forEach(sd => P(new THREE.BoxGeometry(.18, h * .6, D), mat('#a8a294', { roughness: .9 }), sd * (W / 2 - .09), deckH + h * .3, 0));   // 侧壁
          P(new THREE.BoxGeometry(W * .42, .05, D * .4), darkM, 0, deckH + .19, D * .08);                  // 中心投料口（深色）
          const run = D * .45, rl = Math.hypot(deckH, run);
          const ramp = P(new THREE.BoxGeometry(W * .8, .08, rl), mat('#9a948a', { roughness: .9 }), 0, deckH / 2, D / 2 + run / 2);
          ramp.rotation.x = Math.atan2(deckH, run);                                                        // 前引坡：台面斜下到地面
          foot(W, D, deckH + h);
          tag(grp);
        } else if (T3 === 'wtCompactor') {                      // 压缩机：机身 + 进料斗 + 液压推杆（运行中往复）+ 状态灯 + 控制柜
          const hopL = W * .38, bodyL = W - hopL;
          P(new THREE.BoxGeometry(bodyL, h, D), mat('#5f7d94', { metalness: .3, roughness: .6 }), -W / 2 + hopL + bodyL / 2, h / 2, 0);   // 机身
          P(new THREE.BoxGeometry(hopL, h * .55, D), mat('#4d6a80', { metalness: .3, roughness: .6 }), -W / 2 + hopL / 2, h * .28, 0);    // 进料斗下箱
          P(new THREE.BoxGeometry(hopL, .1, D * .8), darkM, -W / 2 + hopL / 2, h * .78, 0);               // 进料斗口
          P(new THREE.BoxGeometry(.5, .8, .35), mat('#3f5a6e', { metalness: .3 }), W * .2, .4, D / 2 + .2);   // 控制柜
          const pl = P(new THREE.SphereGeometry(.08, 12, 8), oneMat(new THREE.MeshBasicMaterial({ color: 0xe8b44a })), -W / 2 + hopL + bodyL * .78, h + .1, -D * .28);
          lamp(pl, 0xe8b44a, 0x3cc46e);                                                                    // 状态灯：待机黄 / 运行绿
          const ram = new THREE.Group(); ram.position.set(-W / 2 + hopL + .25, h * .6, 0); grp.add(ram);
          const cyl = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, Math.max(.6, bodyL * .55), 14), mat('#c9ced3', { metalness: .8, roughness: .25 }));
          cyl.rotation.z = Math.PI / 2; cyl.position.x = -Math.max(.3, bodyL * .27) / 2; cyl.castShadow = true; ram.add(cyl);
          const plate = new THREE.Mesh(new THREE.BoxGeometry(.12, h * .55, D * .82), mat('#7a94a8', { metalness: .4, roughness: .5 }));
          plate.castShadow = true; ram.add(plate);
          const rr = { g: ram, x0: -W / 2 + hopL + .25, range: Math.max(.6, Math.min(W * .3, bodyL * .5)), on };
          vis.runs.push(rr); runs.push(rr);                                                                 // 运行中推杆往复（loop 驱动）
          foot(W, D + .4, h);
          tag(grp);
        } else if (T3 === 'wtBox') {                            // 勾臂转运箱：空心箱体 + 加强筋 + 钩臂槽 + 尾端滚轮 + 容量牌 + 翻盖
          const cols = { green: '#3f9d5c', blue: '#2f7fd0', grey: '#8a9299' };
          const cm = mat(cols[e.style] || cols.green, { metalness: .2, roughness: .6 }), bh = h * .8, t2 = .06;
          P(new THREE.BoxGeometry(W, bh, t2), cm, 0, bh / 2, -D / 2);
          P(new THREE.BoxGeometry(W, bh, t2), cm, 0, bh / 2, D / 2);
          P(new THREE.BoxGeometry(t2, bh, D), cm, -W / 2, bh / 2, 0);
          P(new THREE.BoxGeometry(t2, bh, D), cm, W / 2, bh / 2, 0);
          P(new THREE.BoxGeometry(W - t2 * 2, .08, D - t2 * 2), darkM, 0, .04, 0);                        // 箱底 / 内腔
          [.25, .5, .75].forEach(k => [-1, 1].forEach(sd => P(new THREE.BoxGeometry(.05, .08, D * .96), steelM, sd * (W / 2 + .02), bh * k, 0)));   // 两侧加强筋
          P(new THREE.BoxGeometry(W * .8, .12, .12), steelM, 0, bh + .06, -D / 2);                        // 前端钩臂槽
          [-1, 1].forEach(sd => { const r = P(new THREE.CylinderGeometry(.14, .14, .1, 12), darkM, sd * W * .3, .14, D / 2 + .08); r.rotation.x = Math.PI / 2; });   // 尾端滚轮
          const cap = Math.round(e.cap || 15);
          const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(1.4, W * .35), Math.min(.5, bh * .3)), oneMat(new THREE.MeshBasicMaterial({ map: txtTex('wtCap' + e.id + '_' + cap, 700, 250, `${cap} m³`, '#f4f4ef', '#1f2a33'), transparent: true, toneMapped: false })));
          pl.position.set(W / 2 + .01, bh * .55, 0); pl.rotation.y = Math.PI / 2; pl.castShadow = false; grp.add(pl);   // 侧板容量
          const hinge = new THREE.Group(); hinge.position.set(0, bh, -D / 2); grp.add(hinge);
          const lid = new THREE.Mesh(new THREE.BoxGeometry(W * .96, .06, D * .96), mat(cols[e.style] || cols.green, { metalness: .2, roughness: .55 }));
          lid.position.set(0, .03, D * .5); lid.castShadow = true; hinge.add(lid);
          hinge.traverse(x => { if (x.isMesh) x.userData.park = { kind: 'wt', id: e.id }; });
          vis.lids.push(anim(k => { hinge.rotation.x = -k * 1.15; }));                                     // 盖绕前端上翻
          foot(W, D, bh + .3);
          tag(grp);
        } else if (T3 === 'wtScale') {                          // 汽车地磅：花纹台面 + 黄黑警示端头 + 两端引坡 + 侧立显示柱（不挡人）
          const th = Math.max(.05, M(e.h || 150));
          P(new THREE.BoxGeometry(W, th, D), mat('#8d959c', { metalness: .5, roughness: .45 }), 0, th / 2, 0);
          const n = Math.max(4, Math.round(W / 1.2));
          for (let i = 1; i < n; i++) P(new THREE.BoxGeometry(.05, .02, D * .98), mat('#6f7c86'), -W / 2 + i * W / n, th + .01, 0);   // 台面分格
          [-1, 1].forEach(sd => P(new THREE.BoxGeometry(.16, .04, D), mat('#e8b44a'), sd * (W / 2 - .08), th + .02, 0));   // 黄黑警示边
          [-1, 1].forEach(sd => {
            const run = Math.min(1.2, W * .12);
            const rp = P(new THREE.BoxGeometry(run, .04, D), mat('#9aa1a8', { metalness: .4, roughness: .5 }), sd * (W / 2 + run / 2), th / 2, 0);
            rp.rotation.z = -sd * Math.atan2(th, run);                                                   // 两端引坡
          });
          const px0 = -W * .28, pz0 = D / 2 + .35;
          P(new THREE.CylinderGeometry(.05, .07, 1.55, 10), poleM, px0, .78, pz0);                        // 显示柱
          P(new THREE.BoxGeometry(.8, .42, .06), mat('#101a20'), px0, 1.66, pz0);
          const scr = new THREE.Mesh(new THREE.PlaneGeometry(.7, .32), oneMat(new THREE.MeshBasicMaterial({ map: txtTex('wtSc' + e.id, 700, 320, '电子汽车衡', '#101a20', '#4ef08a'), toneMapped: false })));
          scr.position.set(px0, 1.66, pz0 + .04); scr.castShadow = false; grp.add(scr);
        } else if (T3 === 'wtMist') {                           // 除臭喷淋：双立柱 + 架空管 + 喷头列 + 泵体状态灯 + 水雾（按 on 显示）
          const pipeY = h;
          [-1, 1].forEach(sd => P(new THREE.CylinderGeometry(.06, .08, pipeY, 10), steelM, sd * (W / 2 - .1), pipeY / 2, 0));
          const pipe = P(new THREE.CylinderGeometry(.045, .045, W, 12), steelM, 0, pipeY, 0);
          pipe.rotation.z = Math.PI / 2;
          P(new THREE.BoxGeometry(.5, .6, .4), mat('#3f6f8f', { metalness: .3 }), -W / 2 - .35, .3, 0);   // 泵体
          const pl = P(new THREE.SphereGeometry(.06, 12, 8), oneMat(new THREE.MeshBasicMaterial({ color: 0xe8b44a })), -W / 2 - .35, .66, .21);
          lamp(pl, 0xe8b44a, 0x3cc46e);
          const n = Math.max(3, Math.round(W / .9)), r = Math.max(1, +e.r || 3);
          const mist = new THREE.Group(); mist.visible = on; grp.add(mist);
          vis.mists.push(mist);
          for (let i = 0; i < n; i++) {
            const t = -W / 2 + W * (i + .5) / n;
            P(new THREE.CylinderGeometry(.02, .05, .12, 8), mat('#c9ced3', { metalness: .6 }), t, pipeY - .06, 0);   // 喷头
            const cone = new THREE.Mesh(new THREE.CylinderGeometry(r * .35, .02, r * .9, 10, 1, true), oneMat(new THREE.MeshBasicMaterial({ color: 0xcfe9f7, transparent: true, opacity: .16, side: THREE.DoubleSide, depthWrite: false })));
            cone.position.set(t, pipeY - r * .45, 0); mist.add(cone);                                     // 倒锥水雾
          }
          small(-W / 2 - .1, 0, .18, pipeY); small(W / 2 - .1, 0, .18, pipeY);
          tag(grp);
        } else if (T3 === 'wtSump') {                           // 污水收集池：混凝土池壁 + 深色水面 + 半幅格栅盖板 + 潜污泵
          const rh = Math.max(.2, h), wt2 = .18;
          P(new THREE.BoxGeometry(W, rh, wt2), mat('#b5b0a3', { roughness: .9 }), 0, rh / 2, -D / 2);
          P(new THREE.BoxGeometry(W, rh, wt2), mat('#b5b0a3', { roughness: .9 }), 0, rh / 2, D / 2);
          P(new THREE.BoxGeometry(wt2, rh, D), mat('#b5b0a3', { roughness: .9 }), -W / 2, rh / 2, 0);
          P(new THREE.BoxGeometry(wt2, rh, D), mat('#b5b0a3', { roughness: .9 }), W / 2, rh / 2, 0);
          const wtr = new THREE.Mesh(new THREE.BoxGeometry(W - wt2 * 2, .04, D - wt2 * 2), oneMat(new THREE.MeshPhysicalMaterial({ color: 0x2e4a3a, roughness: .25, transparent: true, opacity: .82 })));
          wtr.position.y = .04; grp.add(wtr);                                                             // 渗滤液水面
          const gn = Math.max(4, Math.round(W / .5));
          for (let i = 0; i < gn; i++) P(new THREE.BoxGeometry(Math.max(.04, W / gn * .55), .05, D * .45), mat('#7a848c', { metalness: .5 }), -W / 2 + (i + .5) * W / gn, rh + .01, D * .27);   // 半幅格栅
          P(new THREE.CylinderGeometry(.12, .15, Math.max(.22, rh * .6), 10), darkM, W * .3, Math.max(.11, rh * .3), -D * .28);   // 潜污泵
          small(0, 0, Math.max(W, D) / 2 + .05, Math.max(rh, .5));
          tag(grp);
        } else if (T3 === 'wtWash') {                           // 洗车台：台面 + 中央通长格栅地沟 + 两侧立柱喷杆（不挡人）
          const th = Math.max(.05, M(e.h || 200));
          P(new THREE.BoxGeometry(W, th, D), mat('#b5b0a3', { roughness: .9 }), 0, th / 2, 0);
          P(new THREE.BoxGeometry(W * .8, .02, D * .3), mat('#3f464c'), 0, th + .01, 0);                  // 地沟底色
          const gn = Math.max(5, Math.round(W * .8 / .5));
          for (let i = 0; i < gn; i++) P(new THREE.BoxGeometry(.05, .03, D * .3), mat('#7a848c', { metalness: .5 }), -W * .4 + (i + .5) * W * .8 / gn, th + .025, 0);   // 格栅条
          [-1, 1].forEach(sd => {
            const bx = sd * W * .3;
            P(new THREE.CylinderGeometry(.06, .08, 2.2, 10), steelM, bx, 1.1, -D / 2 + .15);             // 喷杆立柱
            const arm = P(new THREE.CylinderGeometry(.05, .05, .9, 10), steelM, bx, 2.2, -D / 2 + .6);
            arm.rotation.x = Math.PI / 2;                                                                // 顶横臂（伸向地沟上方）
            P(new THREE.CylinderGeometry(.03, .05, .1, 8), mat('#c9ced3', { metalness: .6 }), bx, 2.12, -D / 2 + .98);   // 喷头
          });
        }
      }
      /* 自动洗车机 3D 建模：底板 / 轨道 / 龙门架（侧滚刷 × 2 + 顶滚刷 + 喷头排 + 泡沫管 + 风干风道，全部随架移动，
         轨道中间不放固定架避免龙门穿架）+ 湿地反光 + 状态灯。整体打 park={kind:'wash'} 标记，点击启动洗车流程。 */
      function buildWash3D(e, ctx, visuals, oneMat, mat) {
        const { grp, P, px, pz, ang, W, h, poleM, darkM } = ctx;
        const D = Math.max(.2, M(e.d || 1200)), on = e.busy === true;
        const steel = mat('#9aa1a8', { metalness: .5, roughness: .5 });
        const vis = { kind: 'wash', W, D, lamp: null, gantry: null, brushes: [], spray: null, sprayCones: null, foamCones: null, blowCones: null, wet: null };
        visuals.set(String(e.id), vis);
        const tag = o => { o.traverse(x => { if (x.isMesh) x.userData.park = { kind: 'wash', id: e.id }; }); return o; };
        // 底板 + 中央排水沟（篦条）+ 两侧行走轨道 + 进 / 出黄色导向箭头
        P(new THREE.BoxGeometry(W, .06, D), mat('#b5b0a3', { roughness: .9 }), 0, .03, 0);
        P(new THREE.BoxGeometry(W * .9, .02, .4), darkM, 0, .07, 0);
        const gn = Math.max(5, Math.round(W * .9 / .5));
        for (let i = 0; i < gn; i++) P(new THREE.BoxGeometry(.05, .025, .4), mat('#7a848c', { metalness: .5 }), -W * .45 + (i + .5) * W * .9 / gn, .085, 0);
        [-1, 1].forEach(sd => P(new THREE.BoxGeometry(W, .08, .16), steel, 0, .1, sd * (D / 2 - .25)));
        [-1, 1].forEach(sd => {
          const x0 = sd * (W / 2 - 1.2);
          [-1, 1].forEach(k => P(new THREE.BoxGeometry(.5, .02, .06), mat('#e8b44a'), x0 + k * .3 * -sd, .07, k * .3 * sd).rotation.y = sd > 0 ? -Math.PI / 4 : Math.PI / 4);
        });
        // 龙门架：双立柱 + 顶梁 + 行走轮，沿轨道往复
        const gh = h - .15, gantry = new THREE.Group(); gantry.position.set(-W / 2 + .9, 0, 0); grp.add(gantry); vis.gantry = gantry;   // 必须登记：carWashStep 靠它驱动龙门往复
        [-1, 1].forEach(sd => {
          const post = new THREE.Mesh(new THREE.BoxGeometry(.22, gh, .22), mat('#3f6f8f', { metalness: .3, roughness: .5 }));
          post.position.set(0, gh / 2, sd * (D / 2 - .25)); post.castShadow = true; gantry.add(post);
          [-1, 1].forEach(k => { const wh = new THREE.Mesh(new THREE.CylinderGeometry(.11, .11, .06, 10), darkM); wh.rotation.z = Math.PI / 2; wh.position.set(k * .08, .11, sd * (D / 2 - .25)); gantry.add(wh); });
        });
        const beam = new THREE.Mesh(new THREE.BoxGeometry(.5, .35, D), mat('#3f6f8f', { metalness: .3, roughness: .5 }));
        beam.position.set(0, gh + .05, 0); beam.castShadow = true; gantry.add(beam);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(.1, 12, 8), oneMat(new THREE.MeshBasicMaterial({ color: on ? 0x3f8fe0 : 0x3cc46e })));
        lamp.position.set(0, gh + .32, 0); gantry.add(lamp); vis.lamp = lamp;
        // 侧滚刷 × 2（毛刷圆柱贴柱内侧）+ 顶滚刷（横置毛刷，组内自转）
        [-1, 1].forEach(sd => {
          const br = new THREE.Mesh(new THREE.CylinderGeometry(.32, .32, 1.7, 14), mat('#4fa3c7', { roughness: .95 }));
          br.position.set(0, .95, sd * (D / 2 - .7)); br.castShadow = true; gantry.add(br);
          vis.brushes.push(br);
        });
        const tbG = new THREE.Group(); tbG.position.set(0, gh - .75, 0); tbG.userData.top = true; gantry.add(tbG);
        const tb = new THREE.Mesh(new THREE.CylinderGeometry(.28, .28, D * .55, 14), mat('#4fa3c7', { roughness: .95 }));
        tb.rotation.x = Math.PI / 2; tb.castShadow = true; tbG.add(tb);
        vis.brushes.push(tbG);
        // 喷水架：顶梁下一排喷头（常驻）+ 倒锥水帘（冲洗段才显示，只显隐水不显隐喷头）
        const spray = new THREE.Group(); gantry.add(spray); vis.spray = spray;
        const sprayC = new THREE.Group(); spray.add(sprayC); vis.sprayCones = sprayC;
        const nn = Math.max(3, Math.round(D / .6));
        for (let i = 0; i < nn; i++) {
          const z2 = -D / 2 + .5 + (D - 1) * i / (nn - 1);
          const nz = new THREE.Mesh(new THREE.CylinderGeometry(.03, .05, .1, 8), mat('#c9ced3', { metalness: .6 })); nz.position.set(0, gh - .28, z2); spray.add(nz);
          const cone = new THREE.Mesh(new THREE.CylinderGeometry(.26, .03, gh - .35, 10, 1, true), oneMat(new THREE.MeshBasicMaterial({ color: 0xbfdff2, transparent: true, opacity: .3, side: THREE.DoubleSide, depthWrite: false })));
          cone.position.set(0, (gh - .35) / 2, z2); sprayC.add(cone);
        }
        // 泡沫喷架（随龙门走，不设固定拱架避免龙门穿架）：横管挂顶梁下（常驻）+ 白色泡沫锥幕（泡沫段才显示）
        const fpipe = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, D - .5, 10), steel); fpipe.rotation.x = Math.PI / 2; fpipe.position.set(0, gh - .32, 0); gantry.add(fpipe);
        const foamC = new THREE.Group(); gantry.add(foamC); vis.foamCones = foamC;
        for (let i = 0; i < nn; i++) {
          const z2 = -D / 2 + .5 + (D - 1) * i / (nn - 1);
          const fc = new THREE.Mesh(new THREE.CylinderGeometry(.3, .05, Math.max(.8, gh - 1.9), 10, 1, true), oneMat(new THREE.MeshBasicMaterial({ color: 0xf6f9fb, transparent: true, opacity: .5, side: THREE.DoubleSide, depthWrite: false })));
          fc.position.set(0, 1.4 + Math.max(.8, gh - 1.9) / 2, z2); foamC.add(fc);
        }
        // 风干机组（随龙门走）：顶梁两侧风道（常驻）+ 向下气流锥（风干段才显示）
        const blowC = new THREE.Group(); gantry.add(blowC); vis.blowCones = blowC;
        [-1, 1].forEach(sd => {
          const duct = new THREE.Mesh(new THREE.BoxGeometry(.36, .28, D * .42), mat('#8d949c', { metalness: .4 })); duct.position.set(.12, gh - .1, sd * D * .22); duct.castShadow = true; gantry.add(duct);
          const air = new THREE.Mesh(new THREE.CylinderGeometry(.18, .4, Math.max(1.2, gh - 1.3), 10, 1, true), oneMat(new THREE.MeshBasicMaterial({ color: 0xeef4f8, transparent: true, opacity: .14, side: THREE.DoubleSide, depthWrite: false })));
          air.position.set(.12, gh - .25 - Math.max(1.2, gh - 1.3) / 2, sd * D * .22); blowC.add(air);
        });
        // 湿地反光：洗车过程中的深色湿痕
        const wet = new THREE.Mesh(new THREE.BoxGeometry(W * .55, .012, D * .85), oneMat(new THREE.MeshBasicMaterial({ color: 0x3a4a55, transparent: true, opacity: .35, depthWrite: false })));
        wet.position.set(0, .075, 0); wet.visible = false; grp.add(wet); vis.wet = wet;
        tag(grp);
        if (on) startWash(e.id, e.dur);                // 方案里洗车中：重建后自动续播到结束
      }
      /* 非标志类道路设施 3D：凸面镜 / 限高杆 / 道口标柱 / 太阳能爆闪灯 / 公交站牌 / 减速带。
         px/pz 为世界坐标（m），h 为标高，ang 为朝向；统一 tagPick 为普通构件可点选。 */
      function buildFacility3D(T3, e, px, pz, h, part, colliders) {
        const ang = ((+e.rot || 0) % 360) * Math.PI / 180;
        const grp = new THREE.Group(); grp.position.set(px, 0, pz); grp.rotation.y = -ang; archUp.add(grp);
        grp.userData.pick3d = T3 === 'facLaneLight' ? { kind: 'facLaneLight', id: e.id } : { kind: 'extra', id: e.id };   // 车道灯整杆可拾取（点击切红/绿），其余设施按普通构件选中
        const P = (geo, m, x, y, z, ry) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); if (ry) o.rotation.y = ry; o.castShadow = o.receiveShadow = true; grp.add(o); return o; };
        const poleM = mat('#6b7075', { metalness: .55, roughness: .5 }), darkM = mat('#3f4549', { metalness: .4, roughness: .6 });
        const W = Math.max(.15, M(e.w || FACILITY_DEFS[T3].w));
        if (T3 === 'facMirror') {                               // 凸面镜：立杆 + 水平横臂 + 竖直略下倾圆镜（银灰镜面 + 深色边框，镜面朝本地 +x 即设施朝向）
          P(new THREE.CylinderGeometry(.07, .1, .2, 12), mat('#8f8a7e'), 0, .1, 0);
          P(new THREE.CylinderGeometry(.04, .06, h - .2, 12), poleM, 0, .1 + (h - .2) / 2, 0);
          const arm = P(new THREE.CylinderGeometry(.035, .035, W * .7, 10), poleM, W * .35, h - .1, 0);
          arm.rotation.z = Math.PI / 2;                         // 圆柱默认沿 Y，绕 Z 转 90° 才水平沿本地 +x 伸出（rotation.y 绕自身轴无效）
          const mirror = new THREE.Group(); mirror.position.set(W * .7, h - .18, 0); mirror.rotation.y = Math.PI / 2; grp.add(mirror);   // 局部 +z 转到朝向 +x
          const ring = new THREE.Mesh(new THREE.TorusGeometry(W / 2, .045, 10, 28), darkM);
          ring.rotation.x = .25; ring.castShadow = ring.receiveShadow = true; mirror.add(ring);
          const face = new THREE.Mesh(new THREE.CircleGeometry(W / 2 - .02, 28), oneMat(new THREE.MeshBasicMaterial({ color: 0xbcc6cc, side: THREE.DoubleSide })));
          face.rotation.x = .25; face.castShadow = false; mirror.add(face);
          colliders.push([px - .12, pz - .12, px + .12, pz + .12, 0, Math.min(h, 2.2)]);
        } else if (T3 === 'facHeightGate') {                    // 限高杆：两侧立柱 + 横梁 + 横梁上方的限高牌
          const half = W / 2, beamY = h;
          [-half, half].forEach(x => {
            P(new THREE.BoxGeometry(.22, beamY, .22), poleM, x, beamY / 2, 0);
            P(new THREE.BoxGeometry(.34, .16, .34), mat('#b9b3a5'), x, .08, 0);
            colliders.push([px + x - .16, pz - .16, px + x + .16, pz + .16, 0, beamY]);
          });
          P(new THREE.BoxGeometry(W + .5, .26, .22), mat('#d9d3c4'), 0, beamY - .1, 0);
          P(new THREE.BoxGeometry(W + .5, .1, .1), mat('#cf3126'), 0, beamY - .26, .12);   // 红条正面
          P(new THREE.BoxGeometry(W + .5, .1, .1), mat('#cf3126'), 0, beamY - .26, -.12);  // 红条背面：两面都有
          const limitM = (+h).toFixed(1);                                                       // 限高值按杆高（米）显示，改高度即同步
          const boardMat = () => oneMat(new THREE.MeshBasicMaterial({ map: signFaceTexture({ type:'signHeightLimit', limit: limitM }), toneMapped:false }));
          const boardGeo = () => new THREE.CircleGeometry(.55, 40);   // 圆形牌面：圆形贴图正好铺满，方面四角会露出黑底
          // 支架：横梁顶的底座 + 两根竖杆 + 牌背横撑，把圆牌固定在横杆上（杆藏在牌背，正面看是两根撑杆托住圆盘）
          P(new THREE.BoxGeometry(.9, .06, .3), darkM, 0, beamY + .05, 0);                       // 底座：骑在横梁顶
          [-.5, .5].forEach(x => P(new THREE.CylinderGeometry(.035, .035, .62, 10), poleM, x, beamY + .37, 0));  // 两根竖撑杆
          P(new THREE.BoxGeometry(1.05, .07, .09), darkM, 0, beamY + .64, 0);                   // 牌背横撑：连竖杆与圆牌
          const boardBody = P(new THREE.CylinderGeometry(.55, .55, .11, 40), mat('#d9d3c4', { roughness:.7 }), 0, beamY + .65, 0);
          boardBody.rotation.x = Math.PI / 2;                                                   // 牌体：薄圆盘，转方向到侧面仍是一块实体圆板，不会只剩线框像被隐藏
          const board = P(boardGeo(), boardMat(), 0, beamY + .65, .058);                    // 正面：朝 +z
          const boardBack = P(boardGeo(), boardMat(), 0, beamY + .65, -.058, Math.PI);      // 背面：朝 -z，字同样正立
          board.castShadow = boardBack.castShadow = false;
        } else if (T3 === 'facBollard') {                       // 道口标柱：红白相间短柱 + 反光环
          const rr = Math.max(.06, W / 2);
          P(new THREE.CylinderGeometry(rr * .9, rr, h, 12), mat('#e6e2d8'), 0, h / 2, 0);
          [.25, .55, .85].forEach(t => P(new THREE.CylinderGeometry(rr * .95, rr * .95, h * .16, 12), mat('#cf3126'), 0, h * t, 0));
          P(new THREE.CylinderGeometry(rr, rr, .05, 12), mat('#8a8f94'), 0, h + .02, 0);
          colliders.push([px - rr, pz - rr, px + rr, pz + rr, 0, h]);
        } else if (T3 === 'facFlashBeacon') {                   // 太阳能爆闪灯：立杆 + 顶部光伏板 + 双侧黄色爆闪灯
          P(new THREE.CylinderGeometry(.07, .1, .2, 12), mat('#8f8a7e'), 0, .1, 0);
          P(new THREE.CylinderGeometry(.035, .055, h - .2, 12), poleM, 0, .1 + (h - .2) / 2, 0);
          const panel = P(new THREE.BoxGeometry(.9, .06, .5), mat('#243b5a', { metalness:.3 }), 0, h + .05, 0);
          panel.rotation.x = -.35;
          [-.16, .16].forEach(z => {
            const lamp = P(new THREE.CylinderGeometry(.09, .09, .06, 12), oneMat(new THREE.MeshBasicMaterial({ color: 0xffc233 })), 0, h - .35, z, Math.PI / 2);
            lamp.userData.flashBeacon = e.id; lamp.castShadow = false;
          });
          colliders.push([px - .12, pz - .12, px + .12, pz + .12, 0, Math.min(h, 2.2)]);
        } else if (T3 === 'facBusStop') {                       // 公交站牌：立杆 + 顶部站名牌（Canvas 图案）
          P(new THREE.CylinderGeometry(.07, .1, .2, 12), mat('#8f8a7e'), 0, .1, 0);
          P(new THREE.CylinderGeometry(.045, .06, h - .2, 12), poleM, 0, .1 + (h - .2) / 2, 0);
          const bw = Math.max(.6, W), bh = bw * .5, by = h - bh / 2 - .1;
          const face = P(new THREE.PlaneGeometry(bw, bh), oneMat(new THREE.MeshBasicMaterial({ map: signFaceTexture({ type:'signParking', text:'公交' }), toneMapped:false })), 0, by, .07);
          face.castShadow = false;
          P(new THREE.BoxGeometry(bw + .08, bh + .08, .06), darkM, 0, by, .02);
          colliders.push([px - .14, pz - .14, px + .14, pz + .14, 0, Math.min(h, 2.2)]);
        } else if (T3 === 'facSpeedBump') {                     // 减速带：贴地黄黑条纹长条
          const L = Math.max(.5, W), d = .35, ht = Math.max(.06, M(e.h || 120));
          const segs = Math.max(6, Math.round(L / .35));
          for (let i = 0; i < segs; i++) {
            const x = -L / 2 + (i + .5) * L / segs;
            const b = new THREE.Mesh(new THREE.BoxGeometry(L / segs + .01, ht, d), mat(i % 2 ? '#1b1b1b' : '#f2c033', { roughness:.8 }));
            b.position.set(x, ht / 2, 0); b.castShadow = b.receiveShadow = true; grp.add(b);
          }
        } else if (T3 === 'facCrosswalk') {                     // 斑马线：贴地白色横条（n 条，沿宽度排列、沿进深延伸），薄标线不可穿行
          const L = Math.max(.5, W), D = Math.max(.5, M(e.d || 3000));
          const n = Math.max(2, Math.min(20, Math.round(+e.n || 6)));
          const ht = Math.max(.012, M(e.h || 40));
          const white = oneMat(new THREE.MeshBasicMaterial({ color: 0xf4f4ef, side: THREE.DoubleSide }));
          const sw = L / n * .55;
          for (let i = 0; i < n; i++) {
            const x = -L / 2 + (i + .5) * L / n;
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(sw, ht, D), white);
            stripe.position.set(x, ht / 2 + .004, 0); stripe.receiveShadow = true; grp.add(stripe);
          }
        } else if (T3 === 'facGuardBooth') {                     // 保安亭：底板 + 四壁（一侧留门窗洞）+ 窗 + 屋顶，整体挡人
          const bw = Math.max(.8, W), bd = Math.max(.8, M(e.d || 2000)), bh = h;
          const wallM = mat('#e6e0d2', { roughness: .9 }), glsM = oneMat(new THREE.MeshPhysicalMaterial({ color: 0x9fc4dc, transparent: true, opacity: .45, roughness: .12, metalness: .05, side: THREE.DoubleSide }));
          P(new THREE.BoxGeometry(bw, .12, bd), mat('#b9b3a5'), 0, .06, 0);                      // 底板
          const sill = Math.max(.6, Math.min(1.0, bh * .32)), winH = Math.max(.7, Math.min(1.5, bh * .5)), head = sill + winH;   // 窗洞：窗台约 0.9m、窗高约 1.4m（亭矮时自动压缩）
          const seg = (w, hh, d, x, y, z) => P(new THREE.BoxGeometry(w, hh, d), wallM, x, y, z);
          const bWinW = Math.max(.8, Math.min(1.8, bw - .4)), bWinX = 0;                            // 背墙窗：居中、尽量做大（两侧各留 0.2m 墙垛）
          seg(bw, sill, .12, 0, sill / 2, -bd / 2);                                               // 背墙：窗下
          if (bh > head) seg(bw, bh - head, .12, 0, head + (bh - head) / 2, -bd / 2);             // 背墙：窗上
          const bL = bWinX - bWinW / 2 + bw / 2, bR = bw / 2 - (bWinX + bWinW / 2);                // 窗洞两侧剩余宽度
          if (bL > .01) seg(bL, winH, .12, -bw / 2 + bL / 2, sill + winH / 2, -bd / 2);           // 背墙：窗左段
          if (bR > .01) seg(bR, winH, .12, bw / 2 - bR / 2, sill + winH / 2, -bd / 2);            // 背墙：窗右段
          const rWinW = Math.max(.8, Math.min(1.8, bd - .4)), rB = bd / 2 - rWinW / 2;             // 左 / 右墙窗（对称）：居中、尽量做大（前后各留 0.2m 墙垛）
          seg(.12, sill, bd, bw / 2, sill / 2, 0);                                                // 右墙：窗下
          if (bh > head) seg(.12, bh - head, bd, bw / 2, head + (bh - head) / 2, 0);              // 右墙：窗上
          seg(.12, winH, rB, bw / 2, sill + winH / 2, -bd / 2 + rB / 2);                           // 右墙：窗后段
          seg(.12, winH, rB, bw / 2, sill + winH / 2, bd / 2 - rB / 2);                            // 右墙：窗前段
          seg(.12, sill, bd, -bw / 2, sill / 2, 0);                                               // 左墙：窗下
          if (bh > head) seg(.12, bh - head, bd, -bw / 2, head + (bh - head) / 2, 0);             // 左墙：窗上
          seg(.12, winH, rB, -bw / 2, sill + winH / 2, -bd / 2 + rB / 2);                          // 左墙：窗后段
          seg(.12, winH, rB, -bw / 2, sill + winH / 2, bd / 2 - rB / 2);                           // 左墙：窗前段
          const doorW = Math.min(.9, bw * .45), doorH = Math.min(2.08, bh * .8), frontZ = bd / 2;
          P(new THREE.BoxGeometry((bw - doorW) / 2, bh, .12), wallM, -(bw + doorW) / 4, bh / 2, frontZ);   // 前墙左段
          P(new THREE.BoxGeometry((bw - doorW) / 2, bh, .12), wallM, (bw + doorW) / 4, bh / 2, frontZ);     // 前墙右段
          if (bh > doorH + .06) P(new THREE.BoxGeometry(doorW, bh - doorH, .12), wallM, 0, doorH + (bh - doorH) / 2, frontZ);   // 门楣：只补门洞上方那段墙
          const leafW = doorW - .04, leafH = doorH - .03;                     // 门扇：铰链在门洞左侧，可点击 / 按 E 开合
          const hinge = new THREE.Group(); hinge.position.set(-doorW / 2 + .02, 0, frontZ); grp.add(hinge);
          const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, .05), mat('#8a6a4a', { roughness: .7 }));
          leaf.position.set(leafW / 2, leafH / 2, 0); leaf.castShadow = true; hinge.add(leaf);
          const dGlass = new THREE.Mesh(new THREE.BoxGeometry(leafW * .62, leafH * .4, .058), glsM);   // 门扇上部玻璃
          dGlass.position.set(leafW / 2, leafH * .72, 0); hinge.add(dGlass);
          const knob = new THREE.Mesh(new THREE.SphereGeometry(.035, 10, 8), mat('#5a5a5a', { metalness: .5, roughness: .4 }));
          knob.position.set(leafW - .1, leafH * .5, .055); hinge.add(knob);
          const gdoor = { open: false, cur: 0, a0: 0, a1: -1.45, pivot: hinge, len: leafW, kind: 'extra', id: e.id };   // 向外开（本地 +z 方向）；len 供关门挡人碰撞按实际扇宽判定
          leaf.userData.door = dGlass.userData.door = knob.userData.door = gdoor;
          doors.push(gdoor);
          const frameM = mat('#c9c3b5', { roughness: .6 });                                       // 窗框：每扇窗做成双扇左右推拉的窗扇（点击窗扇 / 漫游按 E 推拉）
          const slideWin = (bx, by, bz, along, len, out) => {                                     // along='x' 窗沿 x 展开（背墙窗）| 'z' 沿 z 展开（左右墙窗）；out = 室外法向（把手朝外）
            const AX = along === 'x', w = len * .54, run = len - w;                               // 单扇宽 = 54% 洞宽（两扇关着略有重叠），任一边可推开的行程 = 余下 46%
            const base = new THREE.Group(); base.position.set(bx, by, bz); grp.add(base);
            const leaf = (dx, track, step) => {                                                   // dx = 扇沿 along 的起点；track = ±1 内外轨；step = 推开时沿 along 的位移（带符号）
              const sash = { slide: true, win: true, open: false, cur: 0, pivots: [], kind: 'extra', id: e.id };
              const g = new THREE.Group();
              g.position.set(AX ? dx : track * .034, 0, AX ? track * .034 : dx);
              base.add(g);
              const pane = new THREE.Mesh(new THREE.BoxGeometry(AX ? w - .05 : .02, winH - .07, AX ? .02 : w - .05), glsM);
              pane.position.set(AX ? w / 2 : 0, winH / 2, AX ? 0 : w / 2); g.add(pane);           // 玻璃装在扇框内
              const bar = (a, b, c, x, y, z) => {                                                 // 扇框梃条（沿局部轴摆放）
                const m = new THREE.Mesh(new THREE.BoxGeometry(a, b, c), frameM);
                m.position.set(x, y, z); m.castShadow = true; g.add(m);
              };
              const hs = step > 0 ? w - .04 : .04, hy = winH * .5;                                 // 把手装在被推那一侧的竖梃上（不在玻璃上）：两扇合拢时正好落在中缝，且随扇一起移动
              if (AX) {
                bar(.045, winH, .05, .022, winH / 2, 0); bar(.045, winH, .05, w - .022, winH / 2, 0);                      // 左右竖梃
                bar(Math.max(.02, w - .08), .035, .05, w / 2, .018, 0); bar(Math.max(.02, w - .08), .035, .05, w / 2, winH - .018, 0);   // 下 / 上横梃
                bar(.016, .032, .07, hs, hy, out * .035);                                          // 把手连接柱（伸出扇框外侧）
                bar(.032, .13, .032, hs, hy, out * .07);                                           // 把手（竖梃外侧，朝室外）
              } else {
                bar(.05, winH, .045, 0, winH / 2, .022); bar(.05, winH, .045, 0, winH / 2, w - .022);                      // 前后竖梃
                bar(.05, .035, Math.max(.02, w - .08), 0, .018, w / 2); bar(.05, .035, Math.max(.02, w - .08), 0, winH - .018, w / 2);   // 下 / 上横梃
                bar(.07, .032, .016, out * .035, hy, hs);                                          // 把手连接柱
                bar(.032, .13, .032, out * .07, hy, hs);                                           // 把手
              }
              g.traverse(m => { if (m.isMesh) m.userData.door = sash; });                          // 玻璃 + 梃条 + 把手都能点击推拉
              g.userData.door = sash;
              sash.pivots.push({ g, px: g.position.x, pz: g.position.z, ax: AX ? 1 : 0, az: AX ? 0 : 1, dist: step });
              doors.push(sash); return sash;
            };
            const a = leaf(0, 1, run), b = leaf(run, -1, -run);                                    // 前扇向右推 / 后扇向左推，两扇对开
            a.peer = b; b.peer = a;                                                               // 互为对扇：推开一边时另一边自动退回
          };
          slideWin(-bWinW / 2 + .01, sill, -bd / 2 - .075, 'x', bWinW - .02, -1);                   // 背墙窗：双扇左右推拉（把手朝 -z 室外侧）
          slideWin(bw / 2 + .075, sill, -rWinW / 2 + .01, 'z', rWinW - .02, 1);                     // 右墙窗（把手朝 +x）
          slideWin(-bw / 2 - .075, sill, -rWinW / 2 + .01, 'z', rWinW - .02, -1);                   // 左墙窗（把手朝 -x）
          P(new THREE.BoxGeometry(bWinW + .16, .06, .18), frameM, bWinX, sill - .03, -bd / 2 - .06);   // 背窗外窗台板
          P(new THREE.BoxGeometry(.18, .06, rWinW + .16), frameM, bw / 2 + .06, sill - .03, 0);        // 右窗外窗台板
          P(new THREE.BoxGeometry(.18, .06, rWinW + .16), frameM, -bw / 2 - .06, sill - .03, 0);       // 左窗外窗台板
          const roof = P(new THREE.BoxGeometry(bw + .3, .14, bd + .3), mat('#8f96a0', { roughness: .7 }), 0, bh + .07, 0);   // 屋顶
          roof.castShadow = true;
          const gca = Math.cos(ang), gsa = Math.sin(ang), gwp = (lx, lz) => [px + lx * gca - lz * gsa, pz + lx * gsa + lz * gca];
          const wseg = (lx, lz, w2, d2, y1) => {                  // 旋转墙段碰撞：按本地中心 + 尺寸登记 AABB（原整体足迹碰撞盒把门洞一起挡死，漫游进不了亭）
            const q = gwp(lx, lz), ww = (w2 * Math.abs(gca) + d2 * Math.abs(gsa)) / 2, dd = (w2 * Math.abs(gsa) + d2 * Math.abs(gca)) / 2;
            colliders.push([q[0] - ww, q[1] - dd, q[0] + ww, q[1] + dd, 0, y1]);
          };
          wseg(0, -bd / 2, bw, .12, bh);                          // 背墙
          wseg(-bw / 2, 0, .12, bd, bh);                          // 左墙
          wseg(bw / 2, 0, .12, bd, bh);                           // 右墙
          if (bw - doorW > .01) {                                 // 前墙门洞左右两段：门洞处不登记碰撞，关门挡人的事交给可开合的门扇
            wseg(-(bw + doorW) / 4, bd / 2, (bw - doorW) / 2, .12, bh);
            wseg((bw + doorW) / 4, bd / 2, (bw - doorW) / 2, .12, bh);
          }
        } else if (T3 === 'facBarrierGate') {                    // 自动道闸机：机箱 + 红白闸杆（绕机箱顶部枢轴升降），点击机箱 / 闸杆切换
          const al = Math.max(1, W), boxH = h, boxW = .42, boxD = .5;
          P(new THREE.BoxGeometry(boxW + .16, .12, boxD + .16), mat('#8f8a7e'), 0, .06, 0);       // 底座
          const gateBox = P(new THREE.BoxGeometry(boxW, boxH, boxD), mat('#e8e4da', { roughness: .55 }), 0, boxH / 2, 0);   // 机箱
          gateBox.userData.gateArm = e.id;                                                        // 机箱也可点升降
          P(new THREE.BoxGeometry(boxW * .7, .1, .02), oneMat(new THREE.MeshBasicMaterial({ color: 0x2f6f4f })), 0, boxH * .72, boxD / 2 + .012);   // 机箱状态小灯
          const pivot = new THREE.Group(); pivot.position.set(0, boxH - .1, 0); grp.add(pivot);   // 闸杆枢轴（本地 +x 伸出）
          const segs = Math.max(2, Math.round(al / .75)), sw = al / segs;
          for (let i = 0; i < segs; i++) {
            const a2 = new THREE.Mesh(new THREE.BoxGeometry(sw + .005, .09, .09), mat(i % 2 ? '#cf3126' : '#f2f2ee', { roughness: .6 }));
            a2.position.set(sw * (i + .5), 0, 0); a2.castShadow = true; a2.userData.gateArm = e.id; pivot.add(a2);
          }
          const open = e.open === true;
          pivot.rotation.z = open ? 1.35 : 0;                    // 闸杆沿本地 +x 伸出：绕 z 正转才向上抬（负转会插进地面）
          gateArms.push({ open, cur: open ? 1.35 : 0, a0: 0, a1: 1.35, pivot, id: e.id });   // 闸杆动画态，loop 里插值 rotation.z
        } else if (T3 === 'facPlateCam') {                       // 车牌识别：立杆 + 横臂 + 摄像机头 + 镜头，取景朝本地 +x
          P(new THREE.CylinderGeometry(.09, .12, .14, 12), mat('#8f8a7e'), 0, .07, 0);
          P(new THREE.CylinderGeometry(.025, .04, h - .14, 12), poleM, 0, .14 + (h - .14) / 2, 0);
          const arm = P(new THREE.CylinderGeometry(.03, .03, .5, 10), poleM, .25, h - .1, 0);
          arm.rotation.z = Math.PI / 2;
          const head = P(new THREE.BoxGeometry(.34, .16, .18), darkM, .5, h - .12, 0);           // 摄像机头
          const lens = P(new THREE.CylinderGeometry(.055, .055, .06, 14), oneMat(new THREE.MeshBasicMaterial({ color: 0x1b2836 })), .68, h - .12, 0, Math.PI / 2);   // 镜头
          lens.castShadow = false;
          colliders.push([px - .12, pz - .12, px + .12, pz + .12, 0, Math.min(h, 2.2)]);
        } else if (T3 === 'facLoopDetector') {                   // 地感线圈：贴地矩形线圈（细线框），不挡人
          const bw = Math.max(.5, W), bd = Math.max(.4, M(e.d || 1000)), ht = Math.max(.02, M(e.h || 60));
          const wireM = oneMat(new THREE.MeshBasicMaterial({ color: 0x2b2b2b }));
          const bar = (w2, d2, x, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w2, ht, d2), wireM); b.position.set(x, ht / 2 + .004, z); grp.add(b); };
          bar(bw, ht * 1.6, 0, -bd / 2); bar(bw, ht * 1.6, 0, bd / 2);
          bar(ht * 1.6, bd, -bw / 2, 0); bar(ht * 1.6, bd, bw / 2, 0);
        } else if (T3 === 'facPayMachine') {                     // 收费/刷卡机：底座 + 立柱机箱 + 操作屏 + 刷卡区
          const bw = Math.max(.3, W), bh = h, bd = Math.max(.2, bw * .55);
          P(new THREE.CylinderGeometry(.16, .2, .12, 16), mat('#8f8a7e'), 0, .06, 0);
          P(new THREE.CylinderGeometry(.06, .07, bh * .35, 12), poleM, 0, .12 + bh * .175, 0);   // 立柱
          const cy = .12 + bh * .35 + bh * .32;
          P(new THREE.BoxGeometry(bw, bh * .64, bd), mat('#d8d4cb', { roughness: .6 }), 0, cy, 0);  // 机箱
          const scr = P(new THREE.PlaneGeometry(bw * .7, bh * .3), oneMat(new THREE.MeshBasicMaterial({ color: 0x1565a8 })), 0, cy + bh * .1, bd / 2 + .006);   // 操作屏
          scr.castShadow = false;
          P(new THREE.BoxGeometry(bw * .5, .02, .1), darkM, 0, cy - bh * .18, bd / 2 + .03);      // 刷卡槽
          colliders.push([px - bw / 2, pz - bd / 2, px + bw / 2, pz + bd / 2, 0, Math.min(cy + bh * .32, 2.2)]);
        } else if (T3 === 'facLaneLight') {                      // 车道信号灯：立杆 + 双灯灯箱（红上 / 绿下），当前信号亮
          P(new THREE.CylinderGeometry(.08, .11, .14, 12), mat('#8f8a7e'), 0, .07, 0);
          P(new THREE.CylinderGeometry(.025, .038, h - .14, 12), poleM, 0, .14 + (h - .14) / 2, 0);
          const hw = Math.max(.26, M(e.w || 120) * 2.4), hh = hw * 2.1, cy = h - hh / 2 - .08;
          P(new THREE.BoxGeometry(.14, hh, hw), darkM, 0, cy, 0);                                  // 灯箱
          P(new THREE.BoxGeometry(.02, hh * .92, hw * .84), mat('#20262b'), .075, cy, 0);         // 前脸内衬
          [['red', 1], ['green', -1]].forEach(([sig, t]) => {
            const lamp = P(new THREE.SphereGeometry(hw * .32, 14, 10), oneMat(new THREE.MeshBasicMaterial({ color: 0x3a1414 })), .095, cy + t * hh * .27, 0);
            lamp.castShadow = false; lamp.userData.laneLamp = e.id; lamp.userData.lanePos = sig;
          });
          updateLaneLightVisual(e.id);
          colliders.push([px - .12, pz - .12, px + .12, pz + .12, 0, Math.min(h, 2.2)]);
        } else if (isCar(T3)) {                                 // 轿车 / 越野车：连续壳体（侧板自带门窗框，门板与车身共面）+ 内饰 + 机舱 / 行李厢空腔
          const L = Math.max(2.5, W), Wd = Math.max(1.2, M(e.d || FACILITY_DEFS[T3].d)), BH = Math.max(1.1, h), suv = T3 === 'carSuv';
          const paintHex = CAR_COLORS[e.color] || CAR_COLORS.white;
          const paint = mat(paintHex, { metalness:.35, roughness:.32 }), paintDim = mat(paintHex, { metalness:.28, roughness:.45 });
          const glassOp = k => Math.max(.05, Math.min(1, (+e[k] || 16) / 100));                                               // 各块玻璃独立不透明度（面板百分比，越大越不透明）
          const mkGlass = (col, k, rough, metal) => oneMat(new THREE.MeshPhysicalMaterial({ color:col, transparent:true, opacity:glassOp(k), roughness:rough, metalness:metal, side:THREE.DoubleSide }));
          const frontGlass = mkGlass(0x8fb2c6, 'opFront', .06, .02), rearGlass = mkGlass(0x8fb2c6, 'opRear', .06, .02), sunGlassM = mkGlass(0x8fb2c6, 'opSun', .06, .02);
          const doorGlass = mkGlass(0x22384a, 'opDoor', .14, .08);                                                             // 四门侧窗深色贴膜：默认比风挡 / 天窗更不透明
          const chrome = mat('#c6ced5', { metalness:.85, roughness:.18 }), black = mat('#20242a', { roughness:.9 });
          const winBtnMat = oneMat(new THREE.MeshStandardMaterial({ color:0xffc94d, roughness:.35, metalness:.25 }));          // 玻璃升降按钮：琥珀色，深色内饰里更显眼
          const tire = mat('#171a1d', { roughness:.98 }), rimM = mat('#adb6bd', { metalness:.82, roughness:.28 });
          const it = CAR_INTERIORS[e.int] || CAR_INTERIORS.black;
          const innerM = mat(it.seat, { roughness:.94 }), carpetM = mat(it.carpet, { roughness:1 }), engineM = mat('#5b646b', { metalness:.55, roughness:.5 });
          const wr = suv ? Math.min(.40, BH * .24) : Math.min(.33, BH * .22), y0 = wr * .82, belt = Math.min(BH * .63, y0 + (suv ? .78 : .60)), top = BH - .02, ar = wr * 1.14, halfW = Wd * .46, wall = .07;
          const sunL = Math.max(.30, Math.min(L*.28, M(e.sunL || L*140))), sunW = Math.max(.30, Math.min(Wd*.80, M(e.sunW || Wd*360)));  // 天窗玻璃长 / 宽（米）：只控制玻璃开口，车顶棚随开口重新拼装
          const sunX = -L*.07, sunFront = sunX + sunL/2, sunRear = sunX - sunL/2;                                          // 天窗开口中心 / 前后沿
          const sunDist = suv                                                                                              // 越野车平顶加长：滑开行程加大（玻璃抬升越过行李架横杆，后沿推到行李架后横杆前停住，不顶到车尾）
            ? Math.max(L*.015, Math.min(sunL*.75, L*.31 - .05 - sunL/2))
            : Math.max(L*.015, Math.min(sunL*.6, L*.16 - sunL/2));                                                          // 滑开行程：玻璃后沿不越出车顶后段
          const sil = [[-L*.5,y0]];
          [-L*.31,L*.31].forEach(cx=>{for(let i=0;i<=10;i++){const t=Math.PI-i*Math.PI/10;sil.push([cx+Math.cos(t)*ar,y0+Math.sin(t)*ar]);}});
          sil.push([L*.5,y0],[L*.5,belt-.09],...(suv
            ? [[L*.28,belt-.09],[L*.22,top-.06],[L*.20,top],[-L*.38,top],[-L*.42,top-.06],[-L*.46,belt-.09]]
            : [[L*.20,belt-.09],[L*.09,top-.06],[L*.04,top],[-L*.17,top],[-L*.23,top-.06],[-L*.35,belt-.09]]),[-L*.5,belt-.09],[-L*.5,y0]);
          const sideShape = new THREE.Shape();
          sil.forEach(([x,y],i)=> i?sideShape.lineTo(x,y):sideShape.moveTo(x,y)); sideShape.closePath();
          const cutHole = pts => { const h=new THREE.Path(); pts.forEach(([x,y],i)=> i?h.lineTo(x,y):h.moveTo(x,y)); h.closePath(); sideShape.holes.push(h); };
          const frontX = suv ? L*.23 : L*.19, fcx = L*.31;                                                  // 前门洞前沿 / 前轮拱中心：越野车前门加长后，前沿会压进前轮拱
          const fHit = (frontX - fcx) / ar, frontArch = fHit > -1, fEnd = Math.acos(Math.max(-1, Math.min(1, fHit)));  // 前沿压进轮拱时，洞底必须沿拱形抬起；否则洞跑出车身轮廓，三角化后在门洞里留下一片白色面
          const frontBot = [[-L*.04,y0+.03]];                                                                // 前门洞+前侧窗洞合并：belt 处不再有白色洞缘横杆
          if (frontArch) {
            frontBot.push([fcx-ar,y0+.03]);
            for(let i=1;i<=10;i++){const t=Math.PI-i/10*(Math.PI-fEnd);frontBot.push([fcx+ar*Math.cos(t),y0+ar*Math.sin(t)+.03]);}
          } else frontBot.push([frontX,y0+.03]);
          cutHole([...frontBot,[frontX,belt],[suv?L*.20:L*.08,top-.07],[-L*.04,top-.07]]);
          const rcx=-L*.31, rEnd=Math.acos(Math.min(1,(-L*.30-rcx)/ar)), rearBot=[[-L*.06,y0+.03]];
          for(let i=0;i<=10;i++){const t=i/10*rEnd;rearBot.push([rcx+ar*Math.cos(t),y0+ar*Math.sin(t)+.03]);}
          cutHole([...rearBot, ...(suv ? [[-L*.40,belt],[-L*.38,top-.07],[-L*.06,top-.07]] : [[-L*.30,belt],[-L*.22,top-.07],[-L*.06,top-.07]])]);   // 后门洞+后侧窗洞合并：越野车 C 柱更靠后、后侧窗加长
          [-1,1].forEach(sd => { const s=new THREE.Mesh(new THREE.ExtrudeGeometry(sideShape,{depth:wall,bevelEnabled:false,curveSegments:4}),paint);
            s.position.z = sd>0 ? halfW-wall : -halfW; s.castShadow=s.receiveShadow=true; grp.add(s); });                    // 侧板挖出门窗洞，洞缘自身就是门框 / 窗框，无拼接缝
          P(new THREE.BoxGeometry(L*1.01,.012,Wd*1.01), oneMat(new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.2,depthWrite:false})),0,.008,0);
          P(new THREE.BoxGeometry(L*.98,.06,Wd*.92), paintDim, 0, y0+.03, 0);                                              // 地板
          const fTop = suv ? L*.22 : L*.09, rTop = suv ? -L*.38 : -L*.23;                                                   // 车顶前后沿：越野车平顶加长
          P(new THREE.BoxGeometry(fTop-sunFront,.06,halfW*2), paint, (sunFront+fTop)/2, top+.005, 0);                       // 车顶前段：前接风挡上沿、后接天窗玻璃开口
          P(new THREE.BoxGeometry(sunRear-rTop,.06,halfW*2), paint, (sunRear+rTop)/2, top+.005, 0);                         // 车顶后段（滑开的玻璃压在这段上面）
          [-1,1].forEach(sd => P(new THREE.BoxGeometry(sunL,.06,halfW-sunW/2), paint, sunX, top+.005, sd*(halfW+sunW/2)/2)); // 车顶左右段：中间留出天窗开口，可透视座舱
          P(new THREE.BoxGeometry(.05,belt-y0,Wd*.90), paintDim, suv?L*.23:L*.19, (y0+belt)/2, 0);                         // 前围防火墙
          P(new THREE.BoxGeometry(.05,belt-y0,Wd*.90), paintDim, suv?-L*.40:-L*.35, (y0+belt)/2, 0);                       // 后围板
          P(new THREE.BoxGeometry(.06,belt-y0-.10,Wd*.92), paintDim, L*.49, (y0+belt-.10)/2, 0);                           // 车头 / 车尾围板
          P(new THREE.BoxGeometry(.06,belt-y0-.10,Wd*.92), paintDim, -L*.49, (y0+belt-.10)/2, 0);
          const quad = (pts, m, z1, z2, parent) => { const g = new THREE.BufferGeometry(); const v = [];
            for (let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];v.push(...a,z1,...b,z1,...b,z2,...a,z1,...b,z2,...a,z2);}
            g.setAttribute('position', new THREE.Float32BufferAttribute(v,3)); g.computeVertexNormals();
            const o = new THREE.Mesh(g,m); o.castShadow=o.receiveShadow=true; (parent||grp).add(o); return o; };
          const pane = (pts, m, z, parent) => { const g = new THREE.BufferGeometry(); const v = [];   // 真实玻璃面：凸多边形扇形三角化，贴在指定 z 平面上（quad 只画边缘窄带，填不满窗洞）
            for (let i = 1; i < pts.length - 1; i++) v.push(...pts[0], z, ...pts[i], z, ...pts[i+1], z);
            g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
            const o = new THREE.Mesh(g, m); o.castShadow = false; o.receiveShadow = true; (parent || grp).add(o); return o; };
          const glassZ = halfW - wall;                                                                                    // 风挡只铺到两侧板内表面，不再伸进 A/C 柱厚度里造成穿模
          quad(suv ? [[L*.28,belt-.09],[L*.22,top-.06],[L*.22,top+.005],[L*.28,belt]] : [[L*.20,belt-.09],[L*.09,top-.06],[L*.09,top+.005],[L*.20,belt]], frontGlass, -glassZ, glassZ);         // 前风挡：越野车 A 柱更直立
          if (!suv) quad([[-L*.35,belt-.09],[-L*.23,top-.06],[-L*.23,top+.005],[-L*.35,belt]], rearGlass, -glassZ, glassZ);     // 后风挡（越野车后风挡玻璃挂在尾门枢轴上，见 trunkPivot 处：掀尾门时玻璃跟盖板一起上抬）
          P(new THREE.BoxGeometry(L*.52,.02,Wd*.80), carpetM, -L*.05, y0+.075, 0);                                         // 座舱地毯
          [-1, 1].forEach(sd => [L*.00, -L*.18].forEach(sx => {                                                            // 四座：前排略后移，留出腿部空间
            P(new THREE.BoxGeometry(.44,.10,.44), innerM, sx, y0+.30, sd*Wd*.22);
            const back = P(new THREE.BoxGeometry(.12,.40,.44), innerM, sx-.17, y0+.52, sd*Wd*.22); back.rotation.z = -.14;
            P(new THREE.BoxGeometry(.12,.12,.20), innerM, sx-.17, y0+.80, sd*Wd*.22);
          }));
          P(new THREE.BoxGeometry(.28,.16,Wd*.78), innerM, L*.15, y0+.52, 0);                                              // 仪表台
          P(new THREE.BoxGeometry(.50,.10,.18), innerM, -L*.02, y0+.20, 0);                                                // 中央通道
          const swX=L*.07, swY=y0+.62, swZ=-Wd*.22;                                                                       // 方向盘：轮毂 + 转向柱接入仪表台，不再悬空
          const sw = P(new THREE.TorusGeometry(.15,.022,8,18), black, swX, swY, swZ); sw.rotation.y = Math.PI/2;
          const hub = P(new THREE.CylinderGeometry(.05,.05,.03,16), black, swX, swY, swZ); hub.rotation.z = Math.PI/2;
          const swA = new THREE.Vector3(swX,swY,swZ), swB = new THREE.Vector3(L*.15-.08, y0+.55, swZ), swDir = swB.clone().sub(swA);
          const col = P(new THREE.CylinderGeometry(.035,.045,swDir.length(),12), black, (swX+swB.x)/2, (swY+swB.y)/2, swZ);
          col.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), swDir.normalize());
          P(new THREE.BoxGeometry(.72,.36,.62), engineM, L*.33, belt-.34, 0);                                              // 发动机本体（低于机盖，不穿出）
          P(new THREE.BoxGeometry(.26,.20,.22), black, L*.44, belt-.36, Wd*.26);                                           // 蓄电池
          [-1,1].forEach(sd => P(new THREE.BoxGeometry(.16,.16,.16), engineM, L*.28, belt-.20, sd*Wd*.30));                // 减震塔顶
          const spare = P(new THREE.CylinderGeometry(.26,.26,.14,16), black, -L*.42, y0+.20, 0); spare.castShadow = false;  // 行李厢：备胎 + 隔板
          P(new THREE.BoxGeometry(L*.12,.03,Wd*.80), innerM, -L*.42, belt-.20, 0);
          const doorH = belt - y0 + .012, doorCy = (y0 + belt) / 2 + .006;                                            // 门板上沿抬过腰线、与玻璃下缘搭接，腰线处不再透空成缝
          const CAR_PART_LABEL = { doorFL:['左前门','front left door'], doorFR:['右前门','front right door'], doorRL:['左后门','rear left door'], doorRR:['右后门','rear right door'], hood:['前引擎盖','the hood'], trunk:['后备箱门','the trunk'], sunroof:['天窗','the sunroof'] };
          const regCarPart = (part, pivot, a1, axis, label, handleOnly) => {
            const d = { kind:'car', carId:e.id, part, field:part, axis, open:!!e[part], cur:e[part]?1:0, a0:0, a1, pivot, label:CAR_PART_LABEL[part] || [label, label] };
            pivot.traverse(o => { if (o.isMesh) { if (!handleOnly || o.userData.carHandle) o.userData.door = d; o.userData.pick3d = {kind:'extra', id:e.id}; } });
            doors.push(d);
          };
          const rearDoorShape = (x0, dw, fx, rx, yb, yt) => {                                                           // 后门板轮廓：后下角沿后轮拱圆弧切掉，与侧板门洞同一段弧，轮胎正常露出
            const s = new THREE.Shape();
            s.moveTo(fx, yb); s.lineTo(fx, yt); s.lineTo(rx, yt);
            const tEnd = Math.acos(Math.min(1, Math.max(-1, (rx + x0 - rcx) / ar)));
            for (let i = 10; i >= 0; i--) { const t = i / 10 * tEnd;
              s.lineTo(rcx + ar * Math.cos(t) - x0, Math.max(y0 + ar * Math.sin(t) + .03, yb)); }
            s.closePath(); return s;
          };
          const frontDoorShape = (x0, dw, fx, rx, yb, yt) => {                                                           // 前门板轮廓：前沿下角沿前轮拱圆弧切掉，与侧板门洞同一段弧，开门后不留白色面、轮胎正常露出
            const s = new THREE.Shape();
            const tEnd = Math.acos(Math.max(-1, Math.min(1, (x0 + fx - fcx) / ar)));
            s.moveTo(fx, yt); s.lineTo(rx, yt); s.lineTo(rx, yb);
            for (let i = 0; i <= 10; i++) { const t = Math.PI - i/10*(Math.PI - tEnd);
              s.lineTo(fcx + ar*Math.cos(t) - x0, Math.max(y0 + ar*Math.sin(t) + .03, yb)); }
            s.closePath(); return s;
          };
          const frontDoorPivots = {};                                                                                     // 前门枢轴：后视镜挂到前门上，开门时随门转，不再与门板穿模
          [-1, 1].forEach(sd => {                                                                                         // 左右两侧各前后两扇车门（铰链在前缘，门板外沿略突出侧板 2mm）
            [(suv
              ? [L*.23, L*.27, 'doorFL','doorFR','左前门','Front left door','右前门','Front right door', [[L*.23,belt-.012],[L*.20,top-.07],[-L*.04,top-.07],[-L*.04,belt-.012]]]
              : [L*.19, L*.23, 'doorFL','doorFR','左前门','Front left door','右前门','Front right door', [[L*.19,belt-.012],[L*.08,top-.07],[-L*.04,top-.07],[-L*.04,belt-.012]]]),
             (suv
              ? [-L*.06, L*.34, 'doorRL','doorRR','左后门','Rear left door','右后门','Rear right door', [[-L*.06,belt-.012],[-L*.06,top-.07],[-L*.38,top-.07],[-L*.40,belt-.012]]]
              : [-L*.06, L*.24, 'doorRL','doorRR','左后门','Rear left door','右后门','Rear right door', [[-L*.06,belt-.012],[-L*.06,top-.07],[-L*.22,top-.07],[-L*.30,belt-.012]]])].forEach(([x0, dw, fL, fR, zhL, enL, zhR, enR, winPts]) => {
              const pivot = new THREE.Group(); pivot.position.set(x0, 0, sd*(halfW-wall));
              if (fL.startsWith('doorF')) frontDoorPivots[sd] = pivot;
              const isRear = fL === 'doorRL';                                                                            // 后门与后轮拱相交：门板 / 内饰板都要切出轮拱缺口，不再盖住轮胎
              const panelGeo = isRear
                ? new THREE.ExtrudeGeometry(rearDoorShape(x0, dw, .004, -dw-.004, y0, belt), { depth: wall, bevelEnabled: false, curveSegments: 4 })
                : frontArch
                  ? new THREE.ExtrudeGeometry(frontDoorShape(x0, dw, .004, -dw-.004, y0, belt), { depth: wall, bevelEnabled: false, curveSegments: 4 })
                  : new THREE.BoxGeometry(dw+.008, doorH, wall);
              const panel = new THREE.Mesh(panelGeo, paint);
              if (isRear || frontArch) panel.position.z = sd > 0 ? .002 : -wall-.002; else panel.position.set(-dw/2, doorCy, sd*(wall/2+.002)); pivot.add(panel);   // 门板略宽于洞、外沿突出 2mm：盖住洞缘，不与侧板共面闪烁
              const innerGeo = isRear
                ? new THREE.ExtrudeGeometry(rearDoorShape(x0, dw, -dw*.04, -dw*.96, doorCy-doorH*.45, doorCy+doorH*.45), { depth: .014, bevelEnabled: false, curveSegments: 4 })
                : frontArch
                  ? new THREE.ExtrudeGeometry(frontDoorShape(x0, dw, -dw*.04, -dw*.96, doorCy-doorH*.45, doorCy+doorH*.45), { depth: .014, bevelEnabled: false, curveSegments: 4 })
                  : new THREE.BoxGeometry(dw*.92, doorH*.90, .014);
              const inner = new THREE.Mesh(innerGeo, innerM);
              if (isRear || frontArch) inner.position.z = sd > 0 ? -.012 : -.002; else inner.position.set(-dw/2, doorCy, -sd*.005); pivot.add(inner);   // 内饰板紧贴门板内表面，中间不再留 3~4cm 空腔
              const wpts = winPts.map(([px,py])=>[px-x0,py]);
              const winGroup = new THREE.Group(); pivot.add(winGroup);                          // 侧窗玻璃单独成组，随内侧升降按钮上下滑动
              pane(wpts, doorGlass, sd*(wall-.006), winGroup);                                  // 四门侧窗深色贴膜玻璃面：下缘压过腰线、填满窗洞、随门一起开合
              quad(wpts, doorGlass, sd*(wall-.016), sd*(wall-.002), winGroup);                  // 玻璃边框与玻璃面同深度（原来分置门板内外两侧，斜看是一道 5cm 空缝）
              const wField = fL.startsWith('doorF') ? (sd < 0 ? 'winFL' : 'winFR') : (sd < 0 ? 'winRL' : 'winRR');
              const winDoor = { kind:'carWin', carId:e.id, part:wField, field:wField, slide:true,
                open:!!e[wField], cur:e[wField]?1:0, pivots:[{ g:winGroup, px:0, pz:0, ax:0, az:0, dist:0, ay:-(top-.07-(belt-.012)) }],
                label:[fL.startsWith('doorF') ? (sd<0?'左前车窗':'右前车窗') : (sd<0?'左后车窗':'右后车窗'), fL.startsWith('doorF') ? (sd<0?'front left window':'front right window') : (sd<0?'rear left window':'rear right window')] };
              doors.push(winDoor);
              const hd = new THREE.Mesh(new THREE.BoxGeometry(.13,.022,.025), chrome); hd.position.set(-dw*.72, belt-.12, sd*(wall+.014)); hd.userData.carHandle = true; pivot.add(hd);   // 门把手：四个车门唯一可点开合的位置
              const hHit = new THREE.Mesh(new THREE.BoxGeometry(.20,.11,.07), oneMat(new THREE.MeshBasicMaterial({ transparent:true, opacity:0, depthWrite:false }))); hHit.position.set(-dw*.72, belt-.12, sd*(wall+.03)); hHit.userData.carHandle = true; pivot.add(hHit);   // 把手透明命中带，细把手也好点中
              const hdIn = new THREE.Mesh(new THREE.BoxGeometry(.12,.018,.022), chrome); hdIn.position.set(-dw*.72, belt-.12, -sd*.024); hdIn.userData.carHandle = true; pivot.add(hdIn);   // 门内侧把手：坐在车里也能点开合
              const hHitIn = new THREE.Mesh(new THREE.BoxGeometry(.14,.09,.06), oneMat(new THREE.MeshBasicMaterial({ transparent:true, opacity:0, depthWrite:false }))); hHitIn.position.set(-dw*.72, belt-.12, -sd*.035); hHitIn.userData.carHandle = true; pivot.add(hHitIn);   // 内侧把手命中带
              const wb = new THREE.Mesh(new THREE.BoxGeometry(.07,.024,.014), winBtnMat); wb.position.set(-dw*.72+.50, belt-.17, -sd*.026); wb.userData.carWin = winDoor; pivot.add(wb);   // 内侧玻璃升降按钮：琥珀色、略放大，与把手拉开距离避免命中带互相遮挡
              const wbHit = new THREE.Mesh(new THREE.BoxGeometry(.10,.08,.05), oneMat(new THREE.MeshBasicMaterial({ transparent:true, opacity:0, depthWrite:false }))); wbHit.position.set(-dw*.72+.50, belt-.17, -sd*.032); wbHit.userData.carWin = winDoor; pivot.add(wbHit);   // 按钮透明命中带
              grp.add(pivot); regCarPart(sd<0?fL:fR, pivot, sd*1.15, 'y', sd<0?zhL:zhR, true);
            });
          });
          const hoodX = suv ? L*.28 : L*.20, hoodLen = suv ? L*.22 : L*.30;
          const hoodPivot = new THREE.Group(); hoodPivot.position.set(hoodX, belt-.09, 0);
          const hp = new THREE.Mesh(new THREE.BoxGeometry(hoodLen,.04,halfW*2), paint); hp.position.set(hoodLen/2,0,0); hoodPivot.add(hp);                    // 机盖延伸到车头前缘，与侧板机盖平台齐平无缝
          [-1,1].forEach(sl => { const ln = new THREE.Mesh(new THREE.BoxGeometry(hoodLen*.9,.008,.018), paintDim); ln.position.set(hoodLen/2,.006,sl*Wd*.22); hoodPivot.add(ln); });
          grp.add(hoodPivot); regCarPart('hood', hoodPivot, .95, 'z', '前引擎盖');
          const trunkX = suv ? L*.40 : L*.35, trunkLen = suv ? L*.10 : L*.15;
          const tgx = suv ? -L*.38 : -trunkX, tgy = suv ? top+.005 : belt-.09;                                             // 尾门铰链：越野车移到风挡玻璃顶缘（玻璃 + 盖板 + 备胎整块绕车顶后缘上掀，掀背门同款），轿车仍是腰带高度的平置盖板
          const trunkPivot = new THREE.Group(); trunkPivot.position.set(tgx, tgy, 0);
          const tpLen = suv ? L*.04 : trunkLen, tpCx = suv ? -L*.48 : -trunkX-trunkLen/2;                                  // 越野车盖板只留玻璃下缘以外的尾唇：藏在玻璃下面、从铰链连到舱内那节板去掉，开门不再翻出一大块白板
          const tp = new THREE.Mesh(new THREE.BoxGeometry(tpLen,.04,halfW*2), paint); tp.position.set(tpCx-tgx, belt-.09-tgy, 0); trunkPivot.add(tp);                 // 尾门与侧板外沿齐平
          [-1,1].forEach(sl => { const tl = new THREE.Mesh(new THREE.BoxGeometry(tpLen*.87,.008,.018), paintDim); tl.position.set(tpCx-tgx, belt-.084-tgy, sl*Wd*.22); trunkPivot.add(tl); });
          if (suv) {                                                                                                         // 越野车备胎挂在尾门外侧（不写死在车身上）：尾门开合时随门一起掀起
            const spareR = Math.min(.34, wr*1.02);
            const rearSpare = new THREE.Mesh(new THREE.CylinderGeometry(spareR,spareR,.13,20), tire); rearSpare.rotation.z = Math.PI/2; rearSpare.position.set(-trunkX-trunkLen-.055-tgx, belt+.01-tgy, 0); rearSpare.castShadow = true; trunkPivot.add(rearSpare);
            const rearHub = new THREE.Mesh(new THREE.CylinderGeometry(.14,.14,.14,16), chrome); rearHub.rotation.z = Math.PI/2; rearHub.position.copy(rearSpare.position); trunkPivot.add(rearHub);
          }
          if (suv) quad([[-L*.46-tgx, belt-.09-tgy],[-L*.38-tgx, top-.06-tgy],[-L*.38-tgx, top+.005-tgy],[-L*.46-tgx, belt-tgy]], rearGlass, -glassZ, glassZ, trunkPivot);   // 越野车后风挡玻璃：换算成尾门枢轴局部坐标，铰链在玻璃顶缘，掀尾门时玻璃与盖板一起上抬
          if (suv) [-1,1].forEach(sd => { const ax=-L*.38-tgx, ay=top+.005-tgy, bx=-L*.46-tgx, by=belt-tgy;               // 尾门玻璃两侧边框：沿后风挡外缘斜边各贴一条与车身同色的边框，随尾门一起开合
            const flen=Math.hypot(bx-ax,by-ay)+.04, ang=Math.atan2(by-ay,bx-ax);
            const fr=new THREE.Mesh(new THREE.BoxGeometry(flen,.06,.022), paint); fr.position.set((ax+bx)/2,(ay+by)/2, sd*glassZ); fr.rotation.z=ang; fr.castShadow=false; trunkPivot.add(fr); });
          grp.add(trunkPivot); regCarPart('trunk', trunkPivot, suv ? -1.45 : -.95, 'z', '后备箱门');   // 越野车掀背门开度更大：玻璃 + 盖板绕玻璃顶缘上掀至接近竖直，备胎随门抬起
          const sunBase = new THREE.Group(); sunBase.position.set(0, top+.024, 0); grp.add(sunBase);                       // 天窗玻璃内嵌在顶棚开口里（顶面下沉约 5mm，与车顶齐平无外框）
          const sunSlide = new THREE.Group(); sunBase.add(sunSlide);
          const sunGlass = new THREE.Mesh(new THREE.BoxGeometry(sunL,.012,sunW), sunGlassM); sunGlass.position.set(sunX, 0, 0); sunGlass.castShadow = false; sunGlass.receiveShadow = true; sunSlide.add(sunGlass);   // 玻璃不挡光：开孔进阳光，直接看到座椅 / 仪表台
          [-1,1].forEach(sd => { const rf = new THREE.Mesh(new THREE.BoxGeometry(sunL*.96,.018,.02), black); rf.position.set(sunX, -.015, sd*sunW/2); sunSlide.add(rf); });   // 天窗支架：玻璃两侧窄滑轨梁随动（中间镂空，不挡看车内的视线）
          [-1,1].forEach(sd => P(new THREE.BoxGeometry(sunL*.98,.008,.015), black, sunX, top+.012, sd*(sunW/2-.01)).castShadow = false);   // 开口内两条固定滑轨（玻璃沿轨滑动）
          doors.push({ kind:'car', carId:e.id, part:'sunroof', field:'sunroof', slide:true, open:!!e.sunroof, cur:e.sunroof?1:0,   // 滑动式天窗：关闭时嵌在开口内，打开先整块升出顶棚、再沿车顶向后推（真车同款两段式行程）
            pivots:[{ g:sunSlide, px:0, pz:0, ax:-1, az:0, dist:sunDist, ay:suv ? .075 : .04, tph:true }], label:CAR_PART_LABEL.sunroof });   // 越野车抬升量加大：玻璃整体从车顶行李架横杆上方越过，全程不再穿杆
          sunGlass.userData.door = doors[doors.length-1]; sunGlass.userData.pick3d = { kind:'extra', id:e.id };
          [-1, 1].forEach(sd => [-1, 1].forEach(sx => {                                                                    // 四轮：越野车轮胎更宽更大（轮拱已由车身轮廓切出）
            const wx = sx * L * (suv ? .33 : .31), ww = suv ? .24 : .20, rim = suv ? .72 : .67;
            const wh = P(new THREE.CylinderGeometry(wr,wr,ww,20), tire, wx, wr, sd*(halfW-.02)); wh.rotation.x = Math.PI/2;
            const rl = P(new THREE.CylinderGeometry(wr*rim,wr*rim,ww+.005,16), rimM, wx, wr, sd*(halfW-.02)); rl.rotation.x = Math.PI/2; rl.castShadow = false;
            const hb = P(new THREE.CylinderGeometry(wr*.2,wr*.2,ww+.01,12), chrome, wx, wr, sd*(halfW-.02)); hb.rotation.x = Math.PI/2; hb.castShadow = false;
          }));
          const lightsOn = e.lights !== false;                                                                           // 车灯开关：旧方案未设按开灯处理
          if (suv) {                                                                                                       // 越野车专属：车顶行李架 + 射灯 + 侧踏板（备胎已在尾门上）
            [-1,1].forEach(sd => { const rail = new THREE.Mesh(new THREE.BoxGeometry(L*.56,.045,.055), black); rail.position.set(-L*.09, top+.055, sd*halfW*.72); rail.castShadow = true; grp.add(rail); });
            [-L*.32, L*.16].forEach(rx => { const bar = new THREE.Mesh(new THREE.BoxGeometry(.045,.04,halfW*1.44), black); bar.position.set(rx, top+.038, 0); bar.castShadow = true; grp.add(bar); });
            [-1,1].forEach(sd => { const rlamp = new THREE.Mesh(new THREE.CylinderGeometry(.075,.075,.035,14), oneMat(new THREE.MeshBasicMaterial({ color: lightsOn ? 0xfff0c8 : 0x6b6658 }))); rlamp.rotation.x = Math.PI/2; rlamp.position.set(L*.18, top+.10, sd*halfW*.60); rlamp.castShadow = false; grp.add(rlamp); });
            [-1,1].forEach(sd => { const step = new THREE.Mesh(new THREE.BoxGeometry(L*.58,.05,.11), black); step.position.set(-L*.02, y0-.02, sd*(halfW+.09)); step.castShadow = true; grp.add(step); });
          }
          [-1, 1].forEach(sd => {                                                                                         // 保险杠 / 灯组 / 后视镜 / 雨刷
            P(new THREE.BoxGeometry(.08,.11,Wd*.90), paintDim, sd*(L*.5+.02), y0+.10, 0);                                 // 保险杠收薄，车头不再像方柜
            P(new THREE.BoxGeometry(.09,.025,Wd*.90), black, sd*(L*.5+.04), y0+.04, 0);
            [-1, 1].forEach(sl => {                                                                                       // 前后各两只灯：sd 管前后，sl 管左右（不能混用）
              P(new THREE.BoxGeometry(.035,.10,Wd*.18), chrome, sd*(L*.5+.02), belt-.13, sl*Wd*.30);
              const lamp = P(new THREE.BoxGeometry(.025,.075,Wd*.15), oneMat(new THREE.MeshBasicMaterial({color: sd>0 ? (lightsOn?0xfff0c8:0x6b6658) : (lightsOn?0xd43838:0x5c2a2a)})), sd*(L*.5+.045), belt-.13, sl*Wd*.30); lamp.castShadow = false;
              if (sd>0) lamp.userData.carLamp = e.id;                                                                     // 前照灯登记点击切换
            });
            const mirX = suv ? L*.23 : L*.16, mirZ = sd*(halfW+(suv?.10:.09));
            if (frontDoorPivots[sd]) {                                                                                       // 后视镜挂在前门上：开门随门旋转，不再与门板穿模（轿车 / 越野车一致）
              const par = frontDoorPivots[sd], lx = mirX - par.position.x, lz = mirZ - par.position.z;
              const add = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo,m); o.position.set(x,y,z); o.castShadow = o.receiveShadow = true; par.add(o); return o; };
              if (suv) {
                add(new THREE.BoxGeometry(.035,.03,.12), black, lx, belt+.06, lz - sd*.05);                                  // 镜柄
                const shell = add(new THREE.SphereGeometry(1,16,12), paintDim, lx, belt+.09, lz); shell.scale.set(.055,.10,.115);
                add(new THREE.BoxGeometry(.012,.084,.112), black, lx-.057, belt+.09, lz);                                    // 镜面底圈
                const mirror = add(new THREE.BoxGeometry(.008,.074,.10), oneMat(new THREE.MeshBasicMaterial({color:0x8fa8b8})), lx-.065, belt+.09, lz);
                mirror.castShadow = false;
              } else {
                add(new THREE.BoxGeometry(.04,.03,.10), black, lx, belt+.06, lz - sd*.05);
                add(new THREE.BoxGeometry(.12,.07,.05), paintDim, lx, belt+.08, lz);
              }
            }
            P(new THREE.BoxGeometry(.018,.012,Wd*.28), black, L*.19, belt-.05, sd*Wd*.19);                                 // 雨刷贴前风挡根部（门把手已随四门一起运动）
          });
          const beamMat = oneMat(new THREE.MeshBasicMaterial({ color:0xfff2cf, transparent:true, opacity:lightsOn?.13:0, depthWrite:false, side:THREE.DoubleSide }));
          [-1, 1].forEach(sl => {                                                                                         // 前照灯：真实聚光照明 + 可见光束，随车朝向照向前方地面（关灯时熄灭）
            const lx = L*.5 + .06, ly = belt - .13, lz = sl * Wd * .30;
            const spot = new THREE.SpotLight(0xfff2cf, lightsOn?42:0, 11, .34, .5, 1.6);
            spot.position.set(lx, ly, lz); spot.target.position.set(lx + 9, -.35, lz + sl * .5);
            grp.add(spot); grp.add(spot.target);
            const beam = new THREE.Mesh(new THREE.ConeGeometry(1.9, 6, 16, 1, true), beamMat);
            beam.rotation.z = Math.PI / 2 - .08; beam.position.set(lx + 3, ly - .24, lz); beam.renderOrder = 2;
            beam.userData.driveBeam = true; grp.add(beam);
          });
          P(new THREE.BoxGeometry(.025,.085,Wd*.30), black, L*.5+.03, belt-.19, 0);                                        // 进气格栅收窄
          for (let i = 0; i < 2; i++) P(new THREE.BoxGeometry(.012,.008,Wd*.28), chrome, L*.5+.048, belt-.215+i*.05, 0);
          P(new THREE.BoxGeometry(.012,.085,Wd*.16), oneMat(new THREE.MeshBasicMaterial({color:0xf4f2e8})), L*.5+.05, y0+.12, 0);
          P(new THREE.BoxGeometry(.012,.085,Wd*.16), oneMat(new THREE.MeshBasicMaterial({color:0xf4f2e8})), -L*.5-.05, y0+.12, 0);
          const ca = Math.cos(ang), sa = Math.sin(ang);                                                                   // 旋转后的足迹碰撞（整车挡人；驾驶中跳过本车）
          const hw = (L*Math.abs(ca)+Wd*Math.abs(sa))/2, hd = (L*Math.abs(sa)+Wd*Math.abs(ca))/2;
          const carCol = [px-hw, pz-hd, px+hw, pz+hd, 0, BH]; carCol.carId = e.id; colliders.push(carCol);
        } else if (PARK_EXT[T3]) {                              // 停车场配套 19 件：车位标线 / 出入口设备 / 引导配套 / 机械停车
          buildPark3D(T3, e, { grp, P, colliders, doors, px, pz, ang, W, h, poleM, darkM });
        }
      }
      (state.extras || []).forEach(e => {                    // 扩展构件：楼板洞口 / 设备平台 / 停车位 / 凉亭 / 天窗 / 散水 / 挡土墙 / 天沟 / 雨水管
        const s0 = archUp.children.length;
        try {
          const T3 = e.type;
          const box = (w, h, d, x, y, z, m, ry = 0) => {
            const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
            b.position.set(x, y, z); b.rotation.y = ry; b.castShadow = b.receiveShadow = true; archUp.add(b); return b;
          };
          if (isExtraPt(T3)) {                                  // 点构件：雨水管 / 构造柱 / 烟囱 / 景观树 / 安防监控
            const h = Math.max(.3, M(e.h || 2800)), px = wx(e.x), pz = wz(e.y);
            if (isFacility(T3)) {                               // 非标志类道路设施：独立建模
              buildFacility3D(T3, e, px, pz, h, null, colliders); return;
            }
            if (isSecurity(T3)) {                               // 安防监控：摄像头（半球 / 球形云台 / 枪型）+ 录像机 + 显示器
              const mountY = Math.max(.3, M(e.z || (isMonitor(T3) ? 400 : 2800)));
              const ang = ((+e.rot || 0) % 360) * Math.PI / 180;
              const bodyM = mat('#e7ebee', { metalness: .25, roughness: .5 });
              const darkM = mat('#2a3038', { metalness: .45, roughness: .45 });
              const lensM = mat('#101a26', { metalness: .65, roughness: .22 });
              const ledM = mat('#3fd8a0', { emissive: '#3fd8a0', emissiveIntensity: .7 });
              const grp = new THREE.Group(); grp.position.set(px, 0, pz); grp.rotation.y = -ang; archUp.add(grp);   // 部门本地 +x = 取景朝向
              const part = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; grp.add(o); return o; };
              if (isCamType(T3)) {
                const mnt = camMount(e);                                                                        // 安装方式：ceiling 吸顶 / pendant 吊装 / wall 壁装 / pole 立杆
                const drop = mnt === 'pendant' ? Math.max(.1, M(e.drop ?? 400)) : 0;                            // 吊杆长（默认 400mm）
                const attachY = mnt === 'pendant' ? mountY - drop : mnt === 'pole' ? Math.max(.5, mountY) - .12 : mountY;   // 摄像机挂点标高：吊装=吊杆下端，立杆=杆顶往下留支架高度
                if (mnt === 'pendant') {
                  part(new THREE.CylinderGeometry(.075, .075, .022, 18), darkM, 0, mountY, 0);                  // 吸顶盘
                  part(new THREE.CylinderGeometry(.012, .012, drop, 10), darkM, 0, mountY - drop / 2, 0);       // 吊杆
                } else if (mnt === 'wall') {
                  part(new THREE.BoxGeometry(.016, .15, .15), darkM, -.085, attachY - .13, 0);                  // 墙面背板（竖板，法线沿取景方向）
                  part(new THREE.BoxGeometry(.07, .018, .018), bodyM, -.048, attachY - .13, 0);                 // 悬臂支架
                } else if (mnt === 'pole') {
                  const poleLen = Math.max(.5, mountY) - .12;
                  part(new THREE.CylinderGeometry(.11, .13, .02, 16), darkM, 0, .01, 0);                        // 地面底盘
                  part(new THREE.CylinderGeometry(.028, .042, poleLen, 12), bodyM, 0, poleLen / 2, 0);          // 立杆
                  colliders.push([px - .06, pz - .06, px + .06, pz + .06, 0, poleLen]);                         // 立杆占位（挡人）
                } else {
                  part(new THREE.CylinderGeometry(.075, .075, .022, 18), darkM, 0, mountY, 0);                  // 吸顶底盘
                  if (T3 !== 'camDome') part(new THREE.CylinderGeometry(.016, .016, .1, 10), darkM, 0, mountY - .06, 0);   // 短吊杆（半球贴盘，无需）
                }
                if (T3 === 'camDome') {
                  const dome = new THREE.Mesh(new THREE.SphereGeometry(.11, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), bodyM);
                  dome.position.set(0, attachY - .11, 0); dome.rotation.x = Math.PI; dome.castShadow = true; grp.add(dome);   // 半球罩朝下
                  part(new THREE.SphereGeometry(.038, 14, 10), lensM, .045, attachY - .165, 0);                    // 镜头
                  part(new THREE.CylinderGeometry(.012, .012, .008, 12), ledM, -.05, attachY - .15, .055);          // 状态灯
                } else if (T3 === 'camPTZ') {
                  part(new THREE.BoxGeometry(.06, .05, .06), darkM, 0, attachY - .13, 0);                           // 云台
                  const ball = part(new THREE.SphereGeometry(.105, 20, 14), bodyM, 0, attachY - .23, 0);           // 球形护罩
                  ball.scale.y = .92;
                  part(new THREE.CylinderGeometry(.042, .05, .05, 16), lensM, .09, attachY - .25, 0).rotation.z = Math.PI / 2;   // 前伸镜头
                  part(new THREE.SphereGeometry(.012, 10, 8), ledM, .05, attachY - .17, .07);
                } else {                                                                                          // 枪型：横置枪筒 + 支架
                  part(new THREE.BoxGeometry(.05, .06, .05), darkM, 0, attachY - .13, 0);
                  const barrel = part(new THREE.CylinderGeometry(.052, .058, .28, 16), bodyM, .1, attachY - .17, 0);
                  barrel.rotation.z = Math.PI / 2;                                                                // 筒身沿本地 +x（取景方向）
                  part(new THREE.CylinderGeometry(.045, .045, .02, 16), lensM, .245, attachY - .17, 0).rotation.z = Math.PI / 2;
                  part(new THREE.SphereGeometry(.011, 10, 8), ledM, .06, attachY - .12, .05);
                }
                const W = 256, Hh = 144;                                                                          // 离屏取景：16:9
                const rt = new THREE.WebGLRenderTarget(W, Hh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: true });
                rt.texture.colorSpace = THREE.SRGBColorSpace;
                const rc = new THREE.PerspectiveCamera(Math.max(30, Math.min(150, +e.fov || 80)), W / Hh, .05, 120);
                const lensY = attachY - (T3 === 'camBullet' ? .17 : T3 === 'camPTZ' ? .25 : .16);
                rc.position.set(px + Math.cos(ang) * .12, lensY, pz + Math.sin(ang) * .12);
                const pitch = (T3 === 'camDome' ? 48 : T3 === 'camPTZ' ? 30 : 14) * Math.PI / 180, D = 5;
                rc.lookAt(px + Math.cos(ang) * D, lensY - Math.tan(pitch) * D, pz + Math.sin(ang) * D);
                const sc = document.createElement('canvas'); sc.width = W; sc.height = Hh;
                const sctx = sc.getContext('2d', { willReadFrequently: true });
                survRigs.push({ id: e.id, cam: rc, rt, buf: new Uint8Array(W * Hh * 4), src: sc, sctx, img: sctx.createImageData(W, Hh), name: e.name || extraName(e) });
              } else if (isNVR(T3)) {
                const w = Math.max(.25, M(e.w || 400)), d = Math.max(.25, M(e.d || 380)), hh = Math.max(.08, M(e.h || 90));
                part(new THREE.BoxGeometry(w, hh, d), darkM, 0, hh / 2 + .02, 0);                                 // 机架式机箱
                part(new THREE.BoxGeometry(w * .96, .012, d * .96), bodyM, 0, hh + .025, 0);                      // 顶盖
                const n = Math.max(1, Math.min(12, (e.cams || []).length || 4));
                for (let k = 0; k < n; k++) part(new THREE.SphereGeometry(.009, 8, 6), k < (e.cams || []).length ? ledM : mat('#5a636b'), -w * .42 + k * (w * .84 / Math.max(1, n - 1 || 1)), hh * .62, d / 2 + .003);   // 通道指示灯
                part(new THREE.BoxGeometry(w * .34, .018, .004), bodyM, 0, hh * .3, d / 2 + .004);               // 铭牌
                colliders.push([px - w / 2, pz - d / 2, px + w / 2, pz + d / 2, 0, hh + .05]);
              } else {                                                                                            // 显示器：底座 + 支柱 + 屏幕边框 + 显示面
                const w = Math.max(.2, M(e.w || 800)), hh = Math.max(.12, M(e.h || 450));
                const screenBottom = mountY - hh / 2;                                                            // 屏幕下缘标高
                const standY = Math.max(.12, screenBottom - .04);                                                // 支柱顶到屏幕下缘，不再悬空脱节
                part(new THREE.CylinderGeometry(.16, .19, .04, 20), darkM, 0, .02, 0);                            // 底座
                part(new THREE.BoxGeometry(.05, standY, .05), darkM, 0, .04 + standY / 2, 0);                    // 支柱（顶到屏幕下缘）
                part(new THREE.BoxGeometry(.055, hh + .055, w + .055), darkM, .01, mountY, 0);                   // 屏幕边框：与显示面同向（z 向展开、x 向薄），否则与屏幕十字交叉成 X
                part(new THREE.BoxGeometry(.02, hh, w * .9), darkM, -.012, mountY, 0);                           // 屏幕背板：贴在边框后面，背面看不露空框
                const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
                const ctx2 = cv.getContext('2d'); ctx2.fillStyle = '#08101a'; ctx2.fillRect(0, 0, cv.width, cv.height);
                const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
                survTexs.push(tex);
                const face = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
                face.rotation.y = Math.PI / 2; face.position.set(.042, mountY, 0); grp.add(face);                 // 显示面朝本地 +x（屏幕正面）
                survScreens.push({ id: e.id, cv, ctx: ctx2, tex }); survScreenMeshes.push(face);
              }
              return;
            }
            if (T3 === 'tree') {                                // 景观树：树干 + 球状树冠
              const r = Math.max(.15, M(e.w || 900) / 2), trunkM = mat('#7d6247', { roughness: .95 });
              colliders.push([px - r * .14 - .05, pz - r * .14 - .05, px + r * .14 + .05, pz + r * .14 + .05, 0, h * .62]);   // 只挡树干：树冠悬空可走到树下
              const tr = new THREE.Mesh(new THREE.CylinderGeometry(r * .1, r * .14, h * .62, 10), trunkM);
              tr.position.set(px, h * .31, pz); tr.castShadow = true; archUp.add(tr);
              [[h * .62, r], [h * .8, r * .72], [h * .95, r * .45]].forEach(([yy, rr]) => {
                const c = new THREE.Mesh(new THREE.SphereGeometry(rr, 14, 10), mat('#6f8a5c', { roughness: .95 }));
                c.position.set(px, yy, pz); c.castShadow = true; c.scale.y = .86; archUp.add(c);
              });
              return;
            }
            if (T3 === 'tiecol' || T3 === 'chimney') {          // 构造柱 / 烟囱：方柱（构造柱支持长×宽矩形截面；烟囱从屋面标高起）
              const sw = Math.max(.06, M(e.w || 240)), sd = T3 === 'tiecol' ? Math.max(.06, M(e.d || e.w || 240)) : sw;
              const z = T3 === 'chimney' ? Math.max(0, M(e.z || 2800)) : 0;
              const m = mat('#c2bbab', { roughness: .92 });
              if (z < .3) colliders.push([px - sw / 2 - .02, pz - sd / 2 - .02, px + sw / 2 + .02, pz + sd / 2 + .02, z, z + h]);   // 落地构造柱挡人；烟囱从屋面起，不挡地面行走
              box(sw, h, sd, px, z + h / 2, pz, m);
              if (T3 === 'chimney') {
                box(sw + .08, .08, sw + .08, px, z + h + .04, pz, mat('#a9a293', { roughness: .9 }));
                box(sw * .5, .06, sw * .5, px, z + h + .11, pz, mat('#4b453c', { roughness: 1 }));
              }
              return;
            }
            if (T3 === 'flag') {                                // 旗杆：底座 + 细杆 + 顶球 + 竖直旗面 + 升降手柄
              const r = Math.max(.02, M(e.w || 120) / 2);
              colliders.push([px - r * 4, pz - r * 4, px + r * 4, pz + r * 4, 0, .45]);   // 按底座半径挡人（旗面悬空不挡）
              const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 3.2, r * 4, .45, 16), mat('#c9c3b5', { roughness: .9 }));
              base.position.set(px, .225, pz); base.castShadow = base.receiveShadow = true; archUp.add(base);
              const pole = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.3, h, 10), mat('#d8d5cc', { metalness: .4, roughness: .5 }));
              pole.position.set(px, .45 + (h - .45) / 2, pz); pole.castShadow = true; pole.userData.flagId = e.id; pole.userData.flagPoleFor = e.id; archUp.add(pole);   // flagPoleFor 供漫游高亮整杆
              const ball = new THREE.Mesh(new THREE.SphereGeometry(r * 1.8, 10, 8), mat('#c8a45a', { metalness: .6, roughness: .35 }));
              ball.position.set(px, h + r * 1.6, pz); ball.userData.flagId = e.id; archUp.add(ball);
              const fw = Math.max(.5, h * .1), fh = fw * .62;   // 竖直旗面：宽 fw、高 fh，薄面朝 z，顶部贴旗面顶标高（可升降）
              const fy = Math.min(h - .5, Math.max(.5, M(e.flagY ?? Math.round(h * 1000 * .9))));
              const fb = box(fw, fh, .02, px + fw / 2 + r, fy - fh / 2, pz, mat('#a44e3d', { roughness: .8 }));
              fb.userData.flagId = e.id; fb.userData.flagMeshFor = e.id;   // flagMeshFor 供升降动画逐帧定位
              return;
            }
            if (T3 === 'barrier') {                             // 路障：锥桶 / 水马 / 铁马 / 石墩，带朝向
              const st = e.style || 'cone', W = Math.max(.2, M(e.w || 500)), ang = ((+e.rot || 0) % 360) * Math.PI / 180;
              const grp = new THREE.Group(); grp.position.set(px, 0, pz); grp.rotation.y = -ang; archUp.add(grp);
              const part = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; grp.add(o); return o; };
              const orange = mat('#e87722', { roughness: .65 }), white = mat('#f2ece0', { roughness: .7 }), dark = mat('#5d6469', { metalness: .5, roughness: .5 });
              if (st === 'cone') {                              // 交通锥：方底座 + 锥体 + 两道反光白条
                const bw = W, bh = Math.max(.25, h * .12), cr = W * .28;
                part(new THREE.BoxGeometry(bw, bh, bw), dark, 0, bh / 2, 0);
                part(new THREE.CylinderGeometry(cr * .3, cr, h - bh, 16), orange, 0, bh + (h - bh) / 2, 0);
                [.38, .68].forEach(t => {
                  const yy = bh + (h - bh) * t, rr = cr * (1 - t) * .92 + .012;
                  part(new THREE.CylinderGeometry(rr, rr + .012, .055, 16), white, 0, yy, 0);
                });
                colliders.push([px - bw / 2, pz - bw / 2, px + bw / 2, pz + bw / 2, 0, h]);
              } else if (st === 'water') {                      // 水马：注水底座 + 上横梁 + 反光条
                const bw = Math.max(1, W * 2.4), bd = Math.max(.25, W * .6), bh = Math.max(.35, h * .45);
                part(new THREE.BoxGeometry(bw, bh, bd), orange, 0, bh / 2, 0);
                part(new THREE.BoxGeometry(bw * .96, Math.max(.12, h - bh), bd * .72), orange, 0, bh + (h - bh) / 2, 0);
                part(new THREE.BoxGeometry(bw * .6, .07, bd * .78), white, 0, h * .62, 0);
                part(new THREE.BoxGeometry(bw * .6, .07, bd * .78), white, 0, h * .86, 0);
                const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang)), hx = (bw * c + bd * s) / 2, hz = (bw * s + bd * c) / 2;
                colliders.push([px - hx, pz - hz, px + hx, pz + hz, 0, h]);
              } else if (st === 'horse') {                      // 铁马：双立柱 + 两道横杆 + 两支脚
                const bw = Math.max(1, W * 4), bd = Math.max(.18, W * .4);
                [-1, 1].forEach(sd => {
                  part(new THREE.BoxGeometry(.06, h, .06), dark, sd * (bw / 2 - .03), h / 2, 0);
                  part(new THREE.BoxGeometry(.05, h * .55, .05), dark, sd * (bw / 2 - .03), h * .275, sd * bd * .55);   // 支脚
                });
                [.42, .85].forEach(t => part(new THREE.BoxGeometry(bw, .07, .07), orange, 0, h * t, 0));
                const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang)), hx = (bw * c + bd * s) / 2, hz = (bw * s + bd * c) / 2;
                colliders.push([px - hx, pz - hz, px + hx, pz + hz, 0, h]);
              } else {                                          // 石墩：圆柱墩 + 顶盖 + 反光环
                const rr = Math.max(.2, W / 2);
                part(new THREE.CylinderGeometry(rr * .88, rr, h, 18), mat('#c9c5b9', { roughness: .95 }), 0, h / 2, 0);
                part(new THREE.CylinderGeometry(rr * .95, rr * .95, .06, 18), mat('#a9a397', { roughness: .9 }), 0, h + .03, 0);
                [.5, .78].forEach(t => part(new THREE.CylinderGeometry(rr * .9, rr * .9, .05, 18), orange, 0, h * t, 0));
                colliders.push([px - rr, pz - rr, px + rr, pz + rr, 0, h]);
              }
              return;
            }
            if (isTraffic(T3)) {                                  // 交通设施：底座 + 锥形杆 + 碰撞；信号灯挂三灯灯箱，标志牌挂 Canvas 图案板面
              const ang = ((+e.rot || 0) % 360) * Math.PI / 180;
              const grp = new THREE.Group(); grp.position.set(px, 0, pz); grp.rotation.y = -ang; archUp.add(grp);
              grp.userData.pick3d = T3 === 'traflight' ? { kind: 'traflight', id: e.id } : { kind: 'extra', id: e.id };   // 信号灯整杆可拾取（点击切换信号）；标志牌按普通构件选中
              const part = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; grp.add(o); return o; };
              const poleM = mat('#5f666b', { metalness: .55, roughness: .5 }), darkM = mat('#3f4549', { metalness: .45, roughness: .55 });
              part(new THREE.CylinderGeometry(.09, .12, .14, 12), mat('#8f8a7e', { roughness: .9 }), 0, .07, 0);   // 底座
              part(new THREE.CylinderGeometry(.026, .04, h - .14, 12), poleM, 0, .14 + (h - .14) / 2, 0);           // 锥形杆
              colliders.push([px - .12, pz - .12, px + .12, pz + .12, 0, Math.min(h, 2.2)]);                       // 只挡杆脚
              if (T3 === 'traflight') {                           // 信号灯：暗色灯箱 + 前脸三灯（红上 / 黄中 / 绿下），当前信号常亮
                const hw = Math.max(.3, M(e.w || 140) * 2.2), hh = hw * 2.9, cy = h - hh / 2 - .05;
                part(new THREE.BoxGeometry(.16, hh, hw), darkM, 0, cy, 0);                                        // 灯箱
                part(new THREE.BoxGeometry(.024, hh * .94, hw * .86), mat('#20262b', { roughness: .4 }), .085, cy, 0);   // 前脸内衬
                part(new THREE.CylinderGeometry(.055, .075, .1, 8), darkM, 0, h + .02, 0);                        // 顶盖
                [['red', 1], ['yellow', 0], ['green', -1]].forEach(([sig, t]) => {
                  const lamp = part(new THREE.SphereGeometry(hw * .32, 14, 10), oneMat(new THREE.MeshBasicMaterial({ color: 0x3a1414 })), .105, cy + t * hh * .3, 0);
                  lamp.castShadow = false;
                  lamp.userData.trafficLamp = e.id; lamp.userData.trafficPos = sig;   // updateTrafficLampVisual / 点击切换按此定位
                });
                part(new THREE.BoxGeometry(Math.max(.18, hw * .5), .04, .05), poleM, .05, cy, 0);                 // 灯箱连接抱箍
                updateTrafficLampVisual(e.id);                       // 按当前信号点亮（重建后即时同步）
              } else {                                              // 标志牌：圆形 / 八角 / 三角 / 矩形板面，贴 signFaceTexture 图案，默认居中套在立杆上，off 可左右伸出
                const _gd = signDef(T3);                          // 新增标志按配置板形；旧标志维持原逻辑
                const isRectFace = T3 === 'signboard' || (_gd && _gd.shape === 'rect');
                const bw = Math.max(.3, M(e.w || 700)), bh = isRectFace ? bw * (_gd && _gd.portrait ? 2 : .32) : bw;
                const cy = h - bh / 2 - .06, ox = .04;              // 牌面中心对准立杆轴线，向外偏一个杆半径贴在杆身上
                const offM = Math.max(-3, Math.min(3, M(e.off || 0)));   // 左右伸出（m）：正 = 朝向右侧、负 = 左侧（M 已做 mm→m）
                const faceM = oneMat(new THREE.MeshBasicMaterial({ map: signFaceTexture(e), toneMapped: false }));   // 牌面只画正面（单面），背面另铺素色铝板，不再透出镜像图案
                let faceGeo;
                if (isRectFace) faceGeo = new THREE.PlaneGeometry(bw, bh);
                else if (T3 === 'signwarn' || (_gd && _gd.shape === 'tri')) { const s = new THREE.Shape(); s.moveTo(0, .54); s.lineTo(-.5, -.28); s.lineTo(.5, -.28); s.closePath(); faceGeo = remapShapeUV(new THREE.ShapeGeometry(s)); }
                else if (_gd && _gd.shape === 'invtri') { const s = new THREE.Shape(); s.moveTo(-.5, .28); s.lineTo(.5, .28); s.lineTo(0, -.54); s.closePath(); faceGeo = remapShapeUV(new THREE.ShapeGeometry(s)); }
                else if (T3 === 'signstop') { const s = new THREE.Shape(); for (let k = 0; k < 8; k++) { const a2 = k * Math.PI / 4 + Math.PI / 8, x = Math.cos(a2) * .5, y = Math.sin(a2) * .5; k ? s.lineTo(x, y) : s.moveTo(x, y); } s.closePath(); faceGeo = remapShapeUV(new THREE.ShapeGeometry(s)); }
                else faceGeo = new THREE.CircleGeometry(bw / 2, 40);
                if (Math.abs(offM) > .015) {                        // 伸出时：杆顶伸横向臂，牌面横向挂装在臂端（悬臂式标志）
                  const armY = cy + bh / 2 + .035;
                  const arm = part(new THREE.CylinderGeometry(.028, .028, Math.abs(offM) + .12, 12), poleM, 0, armY, offM / 2);
                  arm.rotation.x = Math.PI / 2;                    // 横臂沿左右方向从杆顶伸出
                  part(new THREE.BoxGeometry(.09, .08, .08), darkM, 0, armY - .06, offM);   // 横臂到牌面的挂件
                }
                const face = part(faceGeo, faceM, ox, cy, offM);
                face.rotation.y = Math.PI / 2;                       // 板面法线朝本地 +x（朝向方向）
                face.castShadow = false;
                const back = part(faceGeo, mat('#aeb3b8', { roughness: .85, metalness: .2 }), ox - .008, cy, offM);   // 牌背素色铝板（正面朝本地 -x，从背后看是一块干净的板）
                back.rotation.y = -Math.PI / 2;
                back.castShadow = false;
              }
              return;
            }
            if (T3 === 'streetlamp' || T3 === 'solarlamp') {       // 路灯 / 太阳能路灯：底座 + 锥形灯杆 + 悬臂 / 灯盘 + 发光灯头
              const st = e.style || 'single', r = Math.max(.06, M(e.w || LAMP_STYLES.single.w) / 2);
              const ang = ((+e.rot || 0) % 360) * Math.PI / 180, cosA = Math.cos(ang), sinA = Math.sin(ang);
              const worldOf = (lx, lz) => [px + lx * cosA - lz * sinA, pz + lx * sinA + lz * cosA];   // 灯头局部坐标转世界坐标（grp.rotation.y = -ang）
              const grp = new THREE.Group(); grp.position.set(px, 0, pz); grp.rotation.y = -ang;
              grp.userData.pick3d = { kind: e.type, id: e.id };        // 整杆可拾取：3D 点击切换开关（路灯 / 太阳能路灯）
              archUp.add(grp);
              const part = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; grp.add(o); return o; };
              const poleM = mat('#5f666b', { metalness: .55, roughness: .5 });
              const dark = mat('#3f4549', { metalness: .45, roughness: .55 });
              // 发光材质：一次性实例挂到 lampGlowMats，applyLight 按 on / 夜景统一控制亮度（白天亮灯头、夜景更亮、关灯转暗）
              const glowMat = (color, emissive, factor = 1) => {
                const m = oneMat(new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: .3, roughness: .5 }));
                m.userData.lampRef = e; m.userData.glowFactor = factor; lampGlowMats.push(m); return m;
              };
              const glow = glowMat('#fff2d0', '#ffd98a', 1);
              // 灯头光晕（面向镜头的加色精灵）与地面光斑：让"亮灯"在 3D 里一眼可见，而不只是底座被点光源照到
              const haloMat = oneMat(new THREE.SpriteMaterial({ map: streetPoolTexture(), color: 0xffe8b8, transparent: true, opacity: .25, blending: THREE.AdditiveBlending, depthWrite: false }));
              haloMat.userData.lampRef = e; haloMat.userData.isHalo = true; lampGlowMats.push(haloMat);
              const halo = (x, y, z, size) => { const sp = new THREE.Sprite(haloMat); sp.position.set(x, y, z); sp.scale.set(size, size, 1); sp.renderOrder = 4; grp.add(sp); };
              const pool = (lx, lz, size) => {
                const [gx, gz] = worldOf(lx, lz);
                const pm = oneMat(new THREE.MeshBasicMaterial({ map: streetPoolTexture(), color: 0xffdc9a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
                pm.userData.lampRef = e; pm.userData.isPool = true; lampGlowMats.push(pm);
                const o = new THREE.Mesh(new THREE.PlaneGeometry(size, size), pm);
                o.rotation.x = -Math.PI / 2; o.position.set(gx, .012, gz); o.renderOrder = 3; lampG.add(o);
              };
              const pointLight = (lx, lz, y) => {
                if (e.on === false || (T3 === 'solarlamp' && (e.battery ?? 0) <= 0) || lampG.children.filter(o => o.isPointLight).length >= 28) return;
                const [gx, gz] = worldOf(lx, lz);
                const pl = new THREE.PointLight(0xffd9a8, 0, Math.max(4, (e.r || 12000) / 1000 * 1.25), 1.35);   // intensity 由 applyLight 按夜景 / 开关设置
                pl.position.set(gx, y, gz); pl.userData.lampRef = e; lampG.add(pl);
              };
              part(new THREE.CylinderGeometry(r * 1.6, r * 2, .3, 16), mat('#8f8a7e', { roughness: .92 }), 0, .15, 0);   // 底座
              colliders.push([px - r * 2, pz - r * 2, px + r * 2, pz + r * 2, 0, Math.min(h, 2.2)]);                    // 只挡杆脚，灯头悬空不挡
              const poolSize = Math.max(4, (e.r || 12000) / 1000 * 1.8);
              if (st === 'single' || st === 'double') {             // 单臂 / 双臂：锥形杆 + 水平悬臂 + 端头灯
                part(new THREE.CylinderGeometry(r * .55, r, h - .3, 14), poleM, 0, .3 + (h - .3) / 2, 0);
                const arm = Math.max(.5, M(e.arm || LAMP_STYLES.single.arm));
                (st === 'double' ? [-1, 1] : [1]).forEach(sd => {
                  part(new THREE.BoxGeometry(arm, .07, .07), poleM, sd * arm / 2, h - .12, 0);                       // 悬臂
                  part(new THREE.BoxGeometry(.55, .05, .26), dark, sd * arm, h - .18, 0);                            // 灯壳
                  part(new THREE.BoxGeometry(.48, .035, .2), glow, sd * arm, h - .22, 0);                            // 发光面
                  halo(sd * arm, h - .22, 0, 1.5);                                                                    // 灯头可见光晕
                  pool(sd * arm, 0, poolSize); pointLight(sd * arm, 0, h - .22);                                     // 地面光斑 + 点光源都落在灯头正下方
                });
              } else if (st === 'courtyard') {                       // 庭院灯：矮杆 + 顶部灯笼（四棱罩 + 发光柱）
                part(new THREE.CylinderGeometry(r * .6, r, h - .5, 12), poleM, 0, .3 + (h - .5) / 2, 0);
                part(new THREE.CylinderGeometry(.06, .06, .12, 8), dark, 0, h - .32, 0);
                part(new THREE.CylinderGeometry(.24, .3, .5, 4), glow, 0, h - .05, 0);
                part(new THREE.ConeGeometry(.36, .3, 4), dark, 0, h + .35, 0);
                halo(0, h - .05, 0, 1.8); pool(0, 0, poolSize); pointLight(0, 0, h - .05);
              } else {                                                // 高杆灯：高杆 + 顶部灯盘 + 一圈灯头
                part(new THREE.CylinderGeometry(r * .5, r, h - .4, 16), poleM, 0, .3 + (h - .4) / 2, 0);
                part(new THREE.CylinderGeometry(.7, .7, .08, 16), dark, 0, h - .04, 0);
                for (let k = 0; k < 4; k++) {
                  const a2 = k * Math.PI / 2;
                  const lx = Math.cos(a2) * .48, lz = Math.sin(a2) * .48;
                  part(new THREE.BoxGeometry(.42, .06, .2), glow, lx, h - .12, lz);
                  halo(lx, h - .12, lz, 1.3);
                }
                pool(0, 0, poolSize * 1.2); pointLight(0, 0, h - .12);
              }
              if (T3 === 'solarlamp') {                           // 太阳能路灯：顶部光伏板 + 红色闪烁指示灯 + 杆身电量条
                const bat = Math.max(0, Math.min(100, +e.battery || 0));
                part(new THREE.CylinderGeometry(.035, .035, .45, 8), poleM, 0, h + .2, 0);
                // 光伏板：整块 + 栅格线放进同一个倾斜组，栅格按板的局部坐标分布，避免倾斜后脱板飘空
                const panelG = new THREE.Group(); panelG.position.set(0, h + .48, 0); panelG.rotation.x = -.42; grp.add(panelG);
                const panel = new THREE.Mesh(new THREE.BoxGeometry(1.7, .06, 1.05), mat('#223a5f', { metalness: .35, roughness: .4 }));
                panel.castShadow = panel.receiveShadow = true; panelG.add(panel);
                const cellM = mat('#7fa7d4', { metalness: .3, roughness: .4 });
                for (let k = -1; k <= 1; k++) {                   // 三条栅格线贴板面，沿板宽均布
                  const cell = new THREE.Mesh(new THREE.BoxGeometry(1.66, .012, .015), cellM);
                  cell.position.set(0, .036, k * .3); cell.castShadow = cell.receiveShadow = true; panelG.add(cell);
                }
                // 指示灯与电量显示挂在板底控制盒上（跟随板倾斜），从地面仰视即可看到
                const under = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; panelG.add(o); return o; };
                under(new THREE.BoxGeometry(.4, .16, .14), dark, 0, -.11, .02);                    // 板底控制盒
                const redMat = oneMat(new THREE.MeshStandardMaterial({ color: 0x3b1210, emissive: 0xff2a1f, emissiveIntensity: .1, roughness: .5 }));
                const led = under(new THREE.SphereGeometry(.075, 12, 8), redMat, -.13, -.11, .1);  // 红色指示灯嵌盒正面
                led.userData.solarIndicator = e.id;              // 主循环按充电 / 低电状态闪烁
                under(new THREE.BoxGeometry(.26, .07, .02), dark, .05, -.11, .10);                 // 电量条底槽
                const bcol = bat < 20 ? 0xe5484d : bat < 50 ? 0xe8b44a : 0x3cc46e;
                const fill = under(new THREE.BoxGeometry(.24, .05, .024), oneMat(new THREE.MeshBasicMaterial({ color: bcol })), -.07, -.11, .104);
                fill.userData.solarBatteryBar = e.id;            // 主循环按电量缩放并改色
                fill.userData.barLeft = -.07; fill.userData.barHalf = .12;   // 条左端 / 半宽（updateSolarVisuals 按此左对齐填充）
              }
              return;
            }
            const r = Math.max(.02, M(e.w || 100) / 2);
            colliders.push([px - r - .02, pz - r - .02, px + r + .02, pz + r + .02, 0, h]);   // 雨水管细管也占碰撞
            const pipeMat = mat('#9aa1a6', { metalness: .5, roughness: .45 });
            const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), pipeMat);
            p.position.set(px, h / 2, pz); p.castShadow = true; archUp.add(p);
            [h * .3, h * .72].forEach(y => box(.09, .04, .05, px, y, pz, mat('#7d8489', { metalness: .5, roughness: .5 })));
            if (e.hopper) {                                     // 顶部落水斗：上大下小两节方斗
              box(r * 5, .14, r * 5, px, h + .07, pz, pipeMat);
              box(r * 3, .1, r * 3, px, h + .16, pz, pipeMat);
            }
            return;
          }
          if (isExtraLin(T3)) {                                 // 线性构件：散水 / 挡土墙 / 天沟 / 过梁 / 变形缝 / 挑檐 / 窗台板 / 园路
            const A = [wx(e.a[0]), wz(e.a[1])], B = [wx(e.b[0]), wz(e.b[1])];
            const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < .1 && !(isRoadType(T3) && e.pts && e.pts.length > 2)) return;   // 折线道路首尾可能很近，按总长判断
            const rot = wallAngle(e.a, e.b), mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
            const w = Math.max(.04, M(e.w || (T3 === 'retain' ? 300 : T3 === 'seam' ? 40 : 600))), h = Math.max(.02, M(e.h || 60));
            if (T3 === 'retain') {                              // 挡土墙：实心墙 + 压顶
              box(L, h, w, mx, h / 2, mz, mat('#b9b2a3', { roughness: .95 }), rot);
              box(L + .02, .05, w + .06, mx, h + .025, mz, mat('#cdc6b6', { roughness: .9 }), rot);
              pushWallCollider(e.a, e.b, (e.w || 300), h);         // 实心挡土墙挡人
            } else if (T3 === 'gutter') {                       // 天沟：深色槽底 + 两侧沟壁
              box(L, h, w, mx, h / 2, mz, mat('#8f8b80', { roughness: .9 }), rot);
              const ny = [Math.sin(rot), Math.cos(rot)];          // 墙厚方向的单位向量（3D 中 x/z）
              [-1, 1].forEach(sd => {
                const off = sd * w / 2;
                box(L, h + .04, .04, mx + ny[0] * off, (h + .04) / 2, mz + ny[1] * off, mat('#b6afa0', { roughness: .9 }), rot);
              });
            } else if (T3 === 'lintel' || T3 === 'eave' || T3 === 'sill' || T3 === 'thresh' || T3 === 'band' || T3 === 'signbd') {   // 过梁 / 挑檐 / 窗台板 / 门槛石 / 线脚 / 门头招牌：按标高悬空
              const z = Math.max(0, M(e.z || (T3 === 'sill' ? 900 : T3 === 'lintel' ? 2100 : T3 === 'band' ? 2000 : T3 === 'signbd' ? 2800 : 0)));
              box(L, h, w, mx, z + h / 2, mz, T3 === 'sill' || T3 === 'thresh'
                ? mat('#ded6c6', { roughness: .75 })
                : T3 === 'lintel' ? mat('#c2bbab', { roughness: .92 }) : T3 === 'signbd' ? mat('#44546a', { roughness: .7, metalness: .2 }) : mat('#a9a08e', { roughness: .9 }), rot);
            } else if (T3 === 'seam') {                         // 变形缝：地面窄缝
              box(L, .02, w, mx, .012, mz, mat('#5c554a', { roughness: 1 }), rot);
            } else if (isRoadType(T3)) {                        // 道路：路面 + 路缘 + 车道标线（不挡人，可在上面漫游）
              const st = ROAD_STYLES[T3];
              if (e.pts && e.pts.length > 2) {                  // 折线道路：中心线圆角采样 → 沿路径带状网格
                const sm = roadSamples(e).pts.map(p => ({ x: wx(p.x), z: wz(p.y) }));   // 世界坐标（米）
                for (let i = 0; i < sm.length; i++) {           // 世界系法线 + 累计弧长
                  const a = sm[Math.max(0, i - 1)], b = sm[Math.min(sm.length - 1, i + 1)];
                  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
                  sm[i].nx = -dz / l; sm[i].nz = dx / l;
                  sm[i].s = i ? sm[i - 1].s + Math.hypot(sm[i].x - sm[i - 1].x, sm[i].z - sm[i - 1].z) : 0;
                }
                const RL = sm[sm.length - 1].s;
                const ptAt = s => {                             // 弧长定位（端点 + 法线插值）
                  for (let i = 1; i < sm.length; i++) if (sm[i].s >= s) {
                    const a = sm[i - 1], b = sm[i], f = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
                    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, nx: a.nx + (b.nx - a.nx) * f, nz: a.nz + (b.nz - a.nz) * f };
                  }
                  return sm[sm.length - 1];
                };
                const ribbon = (pts, off, wdt, yTop, m2) => {   // 沿路径带状平面网格（off 横向偏移 / wdt 带宽 / yTop 顶面高，米）
                  if (!pts || pts.length < 2 || wdt <= 0) return;
                  const pos = [], idx = [];
                  pts.forEach(p => {
                    pos.push(p.x + p.nx * (off + wdt / 2), yTop, p.z + p.nz * (off + wdt / 2));
                    pos.push(p.x + p.nx * (off - wdt / 2), yTop, p.z + p.nz * (off - wdt / 2));
                  });
                  for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
                  const g = new THREE.BufferGeometry();
                  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
                  const nor = new Float32Array(pos.length); for (let i = 1; i < nor.length; i += 3) nor[i] = 1;   // 平面朝上，免算法线
                  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
                  g.setIndex(idx);
                  const mesh = new THREE.Mesh(g, m2); mesh.receiveShadow = true; archUp.add(mesh);
                };
                const mmat = (c, o = {}) => mat(c, { ...o, side: THREE.DoubleSide });   // 带状网格双面渲染，防绕序剔除
                const stripe3 = (off, color, thick, pattern) => {
                  const m2 = mmat(color, { roughness: .85 });
                  if (!pattern) { ribbon(sm, off, thick, h + .004, m2); return; }
                  for (let t = 0; t < RL - .05; t += pattern[0] + pattern[1]) {
                    const e0 = Math.min(t + pattern[0], RL - .01); if (e0 - t < .15) break;
                    const seg = [ptAt(t)];                      // 虚线段：区间端点插值 + 区间内全部采样点
                    for (let i = 0; i < sm.length; i++) if (sm[i].s > t && sm[i].s < e0) seg.push(sm[i]);
                    seg.push(ptAt(e0));
                    ribbon(seg, off, thick, h + .004, m2);
                  }
                };
                const dash = st.dash ? [st.dash[0] / 1000, st.dash[1] / 1000] : null;
                const half = w / 2, lay = roadLayout(e);
                ribbon(sm, 0, w, h, mmat(st.fill, { roughness: .95 }));                     // 路面
                if (!st.curb) { const eo = Math.max(0, half - Math.min(.15, half * .12)); [-1, 1].forEach(sd => stripe3(sd * eo, st.edge, .1, null)); }
                if (lay.median > 0) ribbon(sm, 0, lay.median / 1000, h + .11, mmat('#b9b3a5', { roughness: .95 }));   // 中央分隔带顶面
                lay.lines.forEach(li => {                          // 车道分界虚线 / 边线
                  [-1, 1].forEach(sd => stripe3(sd * li.off / 1000, li.kind === 'lane' ? st.mark : st.edge, li.kind === 'lane' ? .12 : .1, li.kind === 'lane' ? dash : null));
                });
                if (st.centerStyle === 'double') [-.1, .1].forEach(o => stripe3(o * lay.scale, st.center, .1, null));
                else if (st.centerStyle === 'dash') stripe3(0, st.center, .12, dash);
                if (st.grid) {                                     // 小道 / 人行道：沿路径铺装分格与路缘
                  const step = st.grid / 1000, n = Math.max(2, Math.round(RL / step));
                  for (let i = 1; i < n; i++) {
                    const p = ptAt(i * RL / n);
                    ribbon([{ x: p.x + p.nx * (half - .005), z: p.z + p.nz * (half - .005), nx: p.nz, nz: -p.nx },
                      { x: p.x - p.nx * (half - .005), z: p.z - p.nz * (half - .005), nx: p.nz, nz: -p.nx }], 0, .02, h + .004, mmat(st.edge, { roughness: .95 }));
                  }
                  if (st.curb) {
                    const co = Math.max(0, half - Math.min(.12, half * .2));
                    [-1, 1].forEach(sd => ribbon(sm, sd * co, .1, h + .05, mmat('#8f887a', { roughness: .95 })));
                  }
                }
                return;
              }
              box(L, h, w, mx, h / 2, mz, mat(st.fill, { roughness: .95 }), rot);
              const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], n = [-u[1], u[0]];
              const pos = (t, off) => [mx + u[0] * t + n[0] * off, mz + u[1] * t + n[1] * off];
              const dash = st.dash ? [st.dash[0] / 1000, st.dash[1] / 1000] : null;
              const stripe = (off, len, color, thick, pattern) => {
                const m = mat(color, { roughness: .85 });
                if (!pattern) { const [px, pz] = pos(0, off); box(len, .012, thick, px, h + .004, pz, m, rot); return; }
                for (let t = -L / 2; t < L / 2 - .05; t += pattern[0] + pattern[1]) {
                  const seg = Math.min(pattern[0], L / 2 - t); if (seg < .15) break;
                  const [px, pz] = pos(t + seg / 2, off);
                  box(seg, .012, thick, px, h + .004, pz, m, rot);
                }
              };
              const half = w / 2;                               // w 为整幅路宽（米），横向偏移一律以半宽为基准
              const lay = roadLayout(e);
              if (!st.curb) { const eo = Math.max(0, half - Math.min(.15, half * .12));[-1, 1].forEach(sd => stripe(sd * eo, L, st.edge, .1)); }
              if (lay.median > 0) {                              // 中央分隔带：按实际宽度生成
                const [px, pz] = pos(0, 0);
                box(L, .22, lay.median / 1000, px, h, pz, mat('#b9b3a5', { roughness: .95 }), rot);
              }
              lay.lines.forEach(li => {                          // 车道分界虚线 / 边线
                [-1, 1].forEach(sd => stripe(sd * li.off / 1000, L, li.kind === 'lane' ? st.mark : st.edge, li.kind === 'lane' ? .12 : .1, li.kind === 'lane' ? dash : null));
              });
              if (st.centerStyle === 'double') [-.1, .1].forEach(o => stripe(o * lay.scale, L, st.center, .1));
              else if (st.centerStyle === 'dash') stripe(0, L, st.center, .12, dash);
              if (st.grid) {                                    // 小道 / 人行道：铺装分格与路缘
                const step = st.grid / 1000, n = Math.max(2, Math.round(L / step));
                for (let i = 1; i < n; i++) { const [px, pz] = pos(-L / 2 + i * L / n, 0); box(.02, .008, w, px, h + .004, pz, mat(st.edge, { roughness: .95 }), rot); }
                if (st.curb) {
                  const co = Math.max(0, half - Math.min(.12, half * .2));
                  [-1, 1].forEach(sd => { const [px, pz] = pos(0, sd * co); box(L, .1, .1, px, h, pz, mat('#8f887a', { roughness: .95 }), rot); });
                }
              }
            } else if (T3 === 'path') {                         // 园路：地面铺装薄板
              box(L, h, w, mx, h / 2, mz, mat('#c9bfa9', { roughness: .95 }), rot);
            } else {                                            // 散水：向外找坡的混凝土带
              box(L, h, w, mx, h / 2, mz, mat('#cfc8b8', { roughness: .95 }), rot);
            }
            return;
          }
          const x0 = wx(e.x - e.w / 2), z0 = wz(e.y - e.d / 2), w = Math.max(.1, M(e.w || 100)), d = Math.max(.1, M(e.d || 100));
          const cx = wx(e.x), cz = wz(e.y);
          if (T3 === 'slabhole') {                              // 楼板洞口：深色洞口 + 四周翻边（视觉上在楼板上开洞）
            const y = M(e.z || 0);
            const voidM = mat('#2f2a24', { roughness: 1 });
            const v = new THREE.Mesh(new THREE.BoxGeometry(w, .02, d), voidM);
            v.position.set(cx, y + .012, cz); v.receiveShadow = true; archUp.add(v);
            const rim = mat('#cfc7b6', { roughness: .9 });
            box(w + .06, .06, .04, cx, y + .03, z0 - .02, rim); box(w + .06, .06, .04, cx, y + .03, z0 + d + .02, rim);
            box(.04, .06, d + .06, x0 - .02, y + .03, cz, rim); box(.04, .06, d + .06, x0 + w + .02, y + .03, cz, rim);
            return;
          }
          if (T3 === 'ac') {                                    // 设备平台：混凝土挑板 + 三面百叶围板
            const th = Math.max(.04, M(e.thick || 100)), y = M(e.z || 0);
            box(w, th, d, cx, y + th / 2, cz, mat('#c6bfae', { roughness: .95 }));
            const lv = mat('#d9d4c8', { roughness: .8 }), n = Math.max(3, Math.round(d / .12));
            const panel = (px, pz, pw, ry) => {
              for (let i = 0; i < n; i++) {
                const yy = y + th + (i + .5) * .09;
                if (yy > y + th + .9) break;
                box(pw, .05, .02, px, yy, pz, lv, ry);
              }
              box(pw, 1.0, .03, px, y + th + .5, pz, mat('#c9c3b6', { roughness: .8 }), ry);
            };
            panel(cx, z0 + .02, w, 0); panel(cx, z0 + d - .02, w, 0);
            panel(x0 + .02, cz, d, Math.PI / 2); panel(x0 + w - .02, cz, d, Math.PI / 2);
            return;
          }
          if (T3 === 'park') {                                  // 停车位：地面标线（四条边线 + 入口横线，标准黄色）
            const m = mat('#f2c531', { roughness: .85 }), y = .02;
            const rot = ((+e.rot || 0) % 360);                    // 整车位旋转：所有标线 / 箭头 / 挡轮杆包进同一 Group 绕中心转
            const grp = new THREE.Group(); grp.position.set(cx, 0, cz); grp.rotation.y = -rot * Math.PI / 180;
            archUp.add(grp);
            const lbox = (bw, bh, bd, x, yy, z, ry = 0) => {     // 相对车位中心的 box
              const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
              b.position.set(x, yy, z); b.rotation.y = ry; b.castShadow = b.receiveShadow = true; grp.add(b); return b;
            };
            lbox(w, .01, .06, 0, y, -d / 2 + .03); lbox(w, .01, .06, 0, y, d / 2 - .03);
            lbox(.06, .01, d, -w / 2 + .03, y, 0); lbox(.06, .01, d, w / 2 - .03, y, 0);
            const ang = ((+e.dir || 0) % 360) * Math.PI / 180, md = Math.min(w, d);   // dir 只控制箭头，坐标相对车位中心
            const uX = Math.sin(ang), uZ = -Math.cos(ang);       // 0° = 朝上（-Z）
            const al = md * .55, ah = Math.max(.07, md * .18), ahw = Math.max(.05, md * .11), ay = y + .006;
            lbox(al - ah, .008, .1, -uX * ah / 2, ay, -uZ * ah / 2, Math.PI / 2 - ang);   // 箭杆
            const tX = uX * al / 2, tZ = uZ * al / 2, bX = uX * (al / 2 - ah), bZ = uZ * (al / 2 - ah);
            const pX = -uZ, pZ = uX, geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute([
              tX, ay, tZ, bX - pX * ahw, ay, bZ - pZ * ahw, bX + pX * ahw, ay, bZ + pZ * ahw
            ], 3));
            geo.computeVertexNormals();
            const tri = new THREE.Mesh(geo, m); tri.receiveShadow = true; grp.add(tri);   // 箭头三角
            const barW = Math.max(.3, w - .3);                    // 挡轮杆固定在车位局部下沿（+Z）
            lbox(barW, .11, .14, 0, .075, d / 2 - .25);
            return;
          }
          if (T3 === 'pavilion') {                              // 凉亭：四角立柱 + 顶盖（外挑 150）
            const h = Math.max(1.8, M(e.h || 2600)), cr = Math.max(.03, M(e.col || 150) / 2);
            const colM = mat('#8d7a5f', { roughness: .85 }), roofM = mat('#7c6a52', { roughness: .9 });
            [[x0 + cr, z0 + cr], [x0 + w - cr, z0 + cr], [x0 + cr, z0 + d - cr], [x0 + w - cr, z0 + d - cr]].forEach(([px, pz]) => {
              const c = new THREE.Mesh(new THREE.CylinderGeometry(cr, cr, h, 12), colM);
              c.position.set(px, h / 2, pz); c.castShadow = true; archUp.add(c);
              colliders.push([px - cr, pz - cr, px + cr, pz + cr, 0, h]);   // 凉亭立柱挡人
            });
            box(w, .1, d, cx, h + .05, cz, roofM);
            box(w + .3, .12, d + .3, cx, h + .16, cz, mat('#6f5f49', { roughness: .9 }));
            return;
          }
          if (T3 === 'carport') {                               // 电动车棚：四角钢柱 + 轻钢平顶
            const h = Math.max(1.8, M(e.h || 2500)), cr = Math.max(.04, M(e.col || 100) / 2);
            const colM = mat('#8a939b', { metalness: .45, roughness: .55 }), roofM = mat('#aab4bc', { roughness: .7, metalness: .2 });
            [[x0 + cr, z0 + cr], [x0 + w - cr, z0 + cr], [x0 + cr, z0 + d - cr], [x0 + w - cr, z0 + d - cr]].forEach(([px, pz]) => {
              const c = new THREE.Mesh(new THREE.CylinderGeometry(cr, cr, h, 10), colM);
              c.position.set(px, h / 2, pz); c.castShadow = true; archUp.add(c);
              colliders.push([px - cr, pz - cr, px + cr, pz + cr, 0, h]);   // 车棚钢柱挡人
            });
            box(w + .25, .07, d + .25, cx, h + .035, cz, roofM);
            box(w + .25, .05, .08, cx, h + .09, z0 - .12, roofM); box(w + .25, .05, .08, cx, h + .09, z0 + d + .12, roofM);
            return;
          }
          if (T3 === 'skylight') {                              // 天窗：屋面翻边 + 凸起玻璃顶
            const y = M(e.z || 2800), h = Math.max(.08, M(e.h || 350));
            const rim = mat('#cfc7b6', { roughness: .9 });
            box(w + .1, h, .1, cx, y + h / 2, z0 - .05, rim); box(w + .1, h, .1, cx, y + h / 2, z0 + d + .05, rim);
            box(.1, h, d + .1, x0 - .05, y + h / 2, cz, rim); box(.1, h, d + .1, x0 + w + .05, y + h / 2, cz, rim);
            const g = new THREE.Mesh(new THREE.BoxGeometry(w, .02, d), glassMat);
            g.position.set(cx, y + h, cz); archUp.add(g);
            [-.5, .5].forEach(t => box(.04, .03, d, cx + w * t, y + h + .02, cz, rim));
            return;
          }
          if (T3 === 'shaft') {                                 // 管道井：四壁井道 + 顶部收口
            const h = Math.max(.6, M(e.h || 2800)), t = Math.max(.06, M(e.t || 120)), m = mat('#c2bbab', { roughness: .95 });
            colliders.push([x0, z0, x0 + w, z0 + d, 0, h]);     // 实体井道：整井占碰撞，人不能走进井里
            box(w, h, t, cx, h / 2, z0 + t / 2, m); box(w, h, t, cx, h / 2, z0 + d - t / 2, m);
            box(t, h, Math.max(.1, d - t * 2), x0 + t / 2, h / 2, cz, m); box(t, h, Math.max(.1, d - t * 2), x0 + w - t / 2, h / 2, cz, m);
            box(w + .06, .06, d + .06, cx, h + .03, cz, mat('#a9a293', { roughness: .9 }));
            return;
          }
          if (T3 === 'lawn') {                                  // 草坪：绿色草皮薄层
            const h = Math.max(.01, M(e.h || 60));
            box(w, h, d, cx, h / 2, cz, mat('#7d9668', { roughness: 1 }));
            return;
          }
          if (T3 === 'well2') {                                 // 雨水井：井圈 + 井盖（篦子样式为 4 条篦条）
            const r = Math.min(w, d) / 2 * .82;
            const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.12, r * 1.12, .12, 20), mat('#b3ac9c', { roughness: .95 }));
            rim.position.set(cx, .06, cz); rim.receiveShadow = true; archUp.add(rim);
            if (e.style === 'grate') {
              const gm = mat('#6e6a60', { metalness: .4, roughness: .6 });
              [-.72, -.24, .24, .72].forEach(t => {
                const bar = new THREE.Mesh(new THREE.BoxGeometry(r * .22, .05, r * 1.8), gm);
                bar.position.set(cx + r * t, .13, cz); bar.castShadow = true; archUp.add(bar);
              });
            } else {
              const cov = new THREE.Mesh(new THREE.CylinderGeometry(r, r, .05, 20), mat('#6e6a60', { metalness: .4, roughness: .6 }));
              cov.position.set(cx, .13, cz); cov.castShadow = true; archUp.add(cov);
            }
            return;
          }
          if (T3 === 'dormer') {                                // 老虎窗：窗箱 + 双坡小顶 + 正面玻璃
            const y = Math.max(0, M(e.z || 2800)), bh = Math.max(.5, M(e.h || 900));
            const wallM = mat('#d8d0bf', { roughness: .92 }), roofM = mat('#7c6a52', { roughness: .9 });
            box(w, bh, d, cx, y + bh / 2, cz, wallM);
            box(w * .68, bh * .62, .03, cx, y + bh * .4, z0 - .015, glassMat);
            const rise = Math.max(.2, Math.min(w, d) * .16), panL = Math.hypot(d / 2, rise), ang = Math.atan2(rise, d / 2);
            [-1, 1].forEach(sd => {
              const m2 = new THREE.Mesh(new THREE.BoxGeometry(w + .18, .06, panL * 1.06), roofM);
              m2.position.set(cx, y + bh + rise / 2, cz + sd * d / 4);
              m2.rotation.x = -sd * ang; m2.castShadow = m2.receiveShadow = true; archUp.add(m2);
            });
            return;
          }
          if (T3 === 'hatch') {                                 // 检修口：四周翻边 + 盖板
            const y = Math.max(0, M(e.z || 2800)), h = Math.max(.06, M(e.h || 250)), t = .1;
            const m = mat('#cfc7b6', { roughness: .9 });
            box(w + .1, h, t, cx, y + h / 2, z0 - .05, m); box(w + .1, h, t, cx, y + h / 2, z0 + d + .05, m);
            box(t, h, d + .1, x0 - .05, y + h / 2, cz, m); box(t, h, d + .1, x0 + w + .05, y + h / 2, cz, m);
            box(w, .05, d, cx, y + h + .025, cz, mat('#9a9488', { metalness: .35, roughness: .55 }));
            return;
          }
          if (T3 === 'solar') {                                 // 太阳能：斜置集热板 + 支架 + 顶部水箱（水箱在高边）
            const y = Math.max(0, M(e.z || 2800)), sh = Math.max(.08, M(e.h || 300));
            const a = Math.PI / 7;                              // 集热板倾角 ~25.7°
            const Wp = Math.max(.4, w * .9), Dp = Math.max(.4, d * .8), t = .05;
            const frontZ = cz - d / 2 + Dp / 2;                 // 前檐（低边）在地面的投影 z
            const backRise = Dp * Math.sin(a);                  // 后檐比前檐抬高
            const g = new THREE.Group();
            g.position.set(cx, y + sh, frontZ);                 // 组原点 = 面板前檐中点
            const panel = new THREE.Group();                    // 以「前檐底沿」为枢轴倾斜
            const pn = new THREE.Mesh(new THREE.BoxGeometry(Wp, t, Dp), mat('#2f4a6b', { metalness: .4, roughness: .3 }));
            pn.position.set(0, t / 2, Dp / 2); pn.castShadow = pn.receiveShadow = true; panel.add(pn);
            for (let i = 0; i < 8; i++) {                       // 集热板面上的真空管 / 板芯分格
              const tube = new THREE.Mesh(new THREE.BoxGeometry(Wp * .94, .018, .025), mat('#3a6b8f', { metalness: .55, roughness: .25 }));
              tube.position.set(0, t / 2 + .011, .06 + i * (Dp * .88 / 8)); tube.castShadow = true; panel.add(tube);
            }
            panel.rotation.x = -a; g.add(panel);
            const tank = new THREE.Mesh(new THREE.CylinderGeometry(.2, .2, Wp * .92, 18), mat('#c9ccd0', { metalness: .55, roughness: .32 }));
            tank.rotation.z = Math.PI / 2;                        // 横置，沿 x 方向
            tank.position.set(0, backRise + .22, Dp * Math.cos(a)); tank.castShadow = true; g.add(tank);
            const legM = mat('#8d9095', { metalness: .5, roughness: .5 });
            [[-1, 0], [1, 0]].forEach(([sd]) => box(.05, sh, .05, cx + sd * (Wp / 2 - .08), y + sh / 2, frontZ - .02, legM));
            [[-1], [1]].forEach(([sd]) => box(.05, sh + backRise, .05, cx + sd * (Wp / 2 - .08), y + (sh + backRise) / 2, frontZ + Dp * Math.cos(a) + .02, legM));
            archUp.add(g);
            return;
          }
          if (T3 === 'equip') {                                 // 设备基础：混凝土基础 + 机组体量
            const t = Math.max(.06, M(e.thick || 150)), y = M(e.z || 0), h = Math.max(.2, M(e.h || 800));
            if (y < .3) colliders.push([x0, z0, x0 + w, z0 + d, y, y + t + h]);   // 落地设备基础挡人；架设在屋面（z 高）时不挡地面
            box(w, t, d, cx, y + t / 2, cz, mat('#c6bfae', { roughness: .95 }));
            box(w * .78, h, d * .78, cx, y + t + h / 2, cz, mat('#b8bcbf', { metalness: .35, roughness: .5 }));
            [-.28, 0, .28].forEach(f => box(w * .7, .02, .02, cx, y + t + h * (.45 + f), cz - d * .39 - .01, mat('#8b9094', { metalness: .4, roughness: .5 })));
            return;
          }
        } finally { markNew(s0, 'extra', e.id); }
      });
      roadJunctions().forEach(pd => {                         // 路口补丁：盖住接头缺口、路面描边与穿过路口的标线
        const y = Math.max(0, pd.h / 1000) + .012;              // 高于直路标线盒顶面（h+.01），把路口内的车道线 / 边线真正盖住
        const P = pd.poly.map(p => [wx(p[0]), wz(p[1])]);
        let a2 = 0;                                            // 统一绕序：俯视逆时针，法线朝上才能被阳光照亮（否则整块发黑）
        for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; a2 += a[0] * b[1] - b[0] * a[1]; }
        if (a2 > 0) P.reverse();
        const pos = [], nor = [];
        for (let i = 1; i < P.length - 1; i++) {
          const A = P[0], B = P[i], C = P[i + 1];
          pos.push(A[0], y, A[1], B[0], y, B[1], C[0], y, C[1]);
          nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
        const mesh = new THREE.Mesh(g, mat(pd.fill, { roughness: .95, side: THREE.DoubleSide }));
        mesh.receiveShadow = true; archUp.add(mesh);
        (pd.lines || []).forEach(ln => {                          // T 字口路缘线：主路远侧连续线 + 近侧两段 + 支路两段，在路口内角交汇
          const ax = wx(ln.a[0]), az = wz(ln.a[1]), bx = wx(ln.b[0]), bz = wz(ln.b[1]);
          const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
          if (len > .01) box(len, .008, .1, (ax + bx) / 2, y + .004, (az + bz) / 2, mat(ln.color, { roughness: .85 }), Math.atan2(-dz, dx));
        });
      });
      (state.pillars || []).forEach(c => {                   // 柱子：方 / 圆 / L 形 / 十字形，从地面通到顶，占碰撞（漫游挡路）
        const r = c.w / 2000, shape = pillarShape(c);
        let m;
        if (shape === 'round') m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, top, 24), wallMat);
        else if (shape === 'L' || shape === 'cross') {
          const shp = new THREE.Shape();
          pillarPts(c).forEach(([px, pz], i) => { const X = px / 1000, Z = pz / 1000; i ? shp.lineTo(X, Z) : shp.moveTo(X, Z); });
          shp.closePath();
          m = new THREE.Mesh(new THREE.ExtrudeGeometry(shp, { depth: top, bevelEnabled: false }), wallMat);
          m.rotation.x = -Math.PI / 2;
          m.position.set(wx(c.x), 0, wz(c.y));
        }
        else m = new THREE.Mesh(new THREE.BoxGeometry(r * 2, top, r * 2), wallMat);
        tagPick(m, 'pillar', c.id);
        if (shape === 'L' || shape === 'cross') { m.castShadow = m.receiveShadow = true; archUp.add(m); }
        else { m.position.set(wx(c.x), top / 2, wz(c.y)); m.castShadow = m.receiveShadow = true; archUp.add(m); }
        colliders.push([wx(c.x) - r, wz(c.y) - r, wx(c.x) + r, wz(c.y) + r, 0, top]);
      });
      (state.stairs || []).forEach(s => {                    // 楼梯：悬空踏板 + 踢面 + 斜梁；双跑 / 三跑带折返平台
        if (s.type === 'ramp') return buildRamp3D(s);        // 坡道单独生成
        if (s.type === 'esc') return buildEsc3D(s);          // 自动扶梯单独生成（梯级滚动动画在主循环）
        if (s.type === 'ladder') return buildLadder3D(s);    // 梯子单独生成（攀爬在 stepWalk）
        if (s.type === 'steps') return buildSteps3D(s);      // 台阶单独生成
        if (s.type === 'spiral') return buildSpiral3D(s);    // 螺旋楼梯单独生成
        const lay = stairLayout(s), W = lay.w / 1000;
        const g = new THREE.Group();
        g.position.set(wx(s.x), 0, wz(s.y)); g.rotation.y = -s.dir * Math.PI / 180; tagPick(g, 'stair', s.id);
        const treadMat = mat('#c9bda6', { roughness: .9 }), riserMat = mat('#b3a58c', { roughness: .9 }),
          beamMat = mat('#8d8069', { roughness: .85 }), landMat = mat('#cfc3ac', { roughness: .9 });
        lay.runs.forEach(r => {
          const dir = Math.sign(r.x1 - r.x0) || 1, runL = Math.abs(r.x1 - r.x0) / 1000;
          const n = r.n || Math.max(2, Math.round(runL / .26)), T = runL / n, R = (r.y1 - r.y0) / n / 1000, z = r.z / 1000;
          const Tmm = Math.abs(r.x1 - r.x0) / n;                                        // 每级进深（mm）
          for (let i = 0; i < n; i++) {
            const xc = (r.x0 + dir * (i + .5) * Tmm) / 1000, ty = r.y0 / 1000 + (i + 1) * R;   // 从该跑起点 x0 排到终点
            const step = new THREE.Mesh(new THREE.BoxGeometry(T, .04, W), treadMat);      // 踏板：薄板悬空
            step.position.set(xc, ty - .02, z);
            const riser = new THREE.Mesh(new THREE.BoxGeometry(.02, R, W), riserMat);     // 踢面：贴在踏板前缘
            riser.position.set(xc + dir * (T / 2 - .01), ty - R / 2, z);
            step.castShadow = riser.castShadow = true; step.receiveShadow = riser.receiveShadow = true;
            g.add(step, riser);
          }
          const aS = s.dir * Math.PI / 180, caS = Math.cos(aS), saS = Math.sin(aS);
          for (let i = 1; i <= n; i++) {                       // 梯段底碰撞：每级踢面一条横向线（y 区间 = 该踢面高度段，单级升超 .34 时收缩）——楼梯底视作实体，漫游不能从梯段下方水平穿过；梯面上因每级升 ≤ 可跨步高 .35，逐级上下不受影响
            const xs = (r.x0 + dir * i * Tmm) / 1000, yi = r.y0 / 1000 + i * R, yp = yi - R;
            addBarrier(wx(s.x) + xs * caS - (z - W / 2) * saS, wz(s.y) + xs * saS + (z - W / 2) * caS,
              wx(s.x) + xs * caS - (z + W / 2) * saS, wz(s.y) + xs * saS + (z + W / 2) * caS,
              yp, Math.min(yi, yp + .34), .25, true);
          }
          const dh = (r.y1 - r.y0) / 1000, slope = Math.hypot(runL, dh), ang = Math.atan2(dh, runL) * dir;
          [-1, 1].forEach(sd => {                              // 两侧斜梁
            const bm = new THREE.Mesh(new THREE.BoxGeometry(slope, .18, .06), beamMat);
            bm.position.set((r.x0 + r.x1) / 2000, (r.y0 + r.y1) / 2000 - .12, z + sd * (W / 2 - .03));
            bm.rotation.z = ang; bm.castShadow = true; bm.receiveShadow = true; g.add(bm);
          });
        });
        lay.lands.forEach(L => {                               // 休息平台：厚板，下方同样镂空
          const pl = new THREE.Mesh(new THREE.BoxGeometry((L.x1 - L.x0) / 1000, .12, (L.z1 - L.z0) / 1000), landMat);
          pl.position.set((L.x0 + L.x1) / 2000, L.y / 1000 - .06, (L.z0 + L.z1) / 2000);
          pl.castShadow = pl.receiveShadow = true; g.add(pl);
        });
        if (s.rail !== false) {                                // 扶手：梯段两侧 + 休息平台四周（扶手高 900）
          const rm2 = s.railMat || 'wood', RH = .9;             // 扶手材质：木制 / 不锈钢 / 玻璃
          const railGlass = rm2 === 'glass', railMat = rm2 === 'wood' ? mat('#6f6152', { roughness: .55 }) : steelMat;
          const seg = (a, b) => {                              // 一段圆管扶手（a / b 为 [x,y,z]）
            const A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
            const d = new THREE.Vector3().subVectors(B, A), L = d.length();
            const m = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, L, 10), railMat);
            m.position.copy(A).add(B).multiplyScalar(.5);
            m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
            m.castShadow = true; g.add(m);
          };
          const post = (x, y, z) => {                          // 立柱
            const m = new THREE.Mesh(new THREE.BoxGeometry(.04, RH, .04), railMat);
            m.position.set(x, y + RH / 2, z); m.castShadow = true; g.add(m);
          };
          const line = (x0, z0, x1, z1, y0, y1) => {           // 沿一段直线布扶手 + 均分立柱
            const a = s.dir * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);   // 局部(米)→世界：dx=lx·ca-lz·sa, dz=lx·sa+lz·ca
            addBarrier(wx(s.x) + x0 * ca - z0 * sa, wz(s.y) + x0 * sa + z0 * ca,
              wx(s.x) + x1 * ca - z1 * sa, wz(s.y) + x1 * sa + z1 * ca,
              Math.min(y0, y1), Math.max(y0, y1) + RH, .18);            // 带高度线段碰撞：扶手只在其高度拦人，不挡梯段中间通行
            seg([x0, y0 + RH, z0], [x1, y1 + RH, z1]);
            if (railGlass) {                                   // 玻璃栏板：斜面梯形，贴合梯段坡度
              const h = RH - .06, gg = new THREE.BufferGeometry();
              gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
                x0, y0, z0, x1, y1, z1, x1, y1 + h, z1,
                x0, y0, z0, x1, y1 + h, z1, x0, y0 + h, z0,
              ]), 3));
              gg.computeVertexNormals(); g.add(new THREE.Mesh(gg, glassMat));
            }
            const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0), n = Math.max(2, Math.round(L / 1.1));
            for (let i = 0; i <= n; i++) {
              if (railGlass && i !== 0 && i !== n && i !== Math.round(n / 2)) continue;   // 玻璃栏板只在两端与中间加立柱
              const t = i / n;
              post(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t);
            }
          };
          const side = s.railSide || 'both', usedZ = [], runEnds = [];   // 扶手位置：两侧 / 左侧 / 右侧（沿上行方向看）
          lay.runs.forEach(r => {
            const x0 = r.x0 / 1000, x1 = r.x1 / 1000, y0 = r.y0 / 1000, y1 = r.y1 / 1000, z = r.z / 1000;
            const asc = Math.sign(r.x1 - r.x0) || 1, leftSd = asc > 0 ? -1 : 1;   // 上行 +x 时左手边是 -z
            (side === 'both' ? [-1, 1] : side === 'left' ? [leftSd] : [-leftSd]).forEach(sd => {
              const zz = z + sd * (W / 2 - .045);
              line(x0, zz, x1, zz, y0, y1); usedZ.push(zz); runEnds.push([x0, y0, zz], [x1, y1, zz]);
            });
          });
          if (s.railLand !== false) lay.lands.forEach(L => {   // 平台：四周一圈围栏（平台扶手可单独关），梯段接入的那段断开留口
            const x0 = L.x0 / 1000, x1 = L.x1 / 1000, z0 = L.z0 / 1000, z1 = L.z1 / 1000, y = L.y / 1000;
            const used = z => usedZ.some(v => Math.abs(v - z) < .03);     // 只在梯段扶手接过来的那条边加长边
            if (side === 'both' || used(z0 + .045)) line(x0 + .045, z0 + .045, x1 - .045, z0 + .045, y, y);
            if (side === 'both' || used(z1 - .045)) line(x0 + .045, z1 - .045, x1 - .045, z1 - .045, y, y);
            runEnds.forEach(([rx, ry, rz]) => {                 // 梯段扶手 → 平台扶手：补齐平台边 45mm 内缩造成的断头，外露侧连成一道
              if (Math.abs(ry - y) > .02) return;
              const edge = Math.abs(rx - x0) < Math.abs(rx - x1) ? x0 : x1;
              if (Math.abs(rx - edge) > .25) return;
              const sideZ = Math.abs(rz - (z0 + .045)) < Math.abs(rz - (z1 - .045)) ? z0 + .045 : z1 - .045;
              if (Math.abs(rz - sideZ) < .3 && (side === 'both' || used(sideZ))) {
                const px = Math.max(x0 + .045, Math.min(x1 - .045, edge + (edge === x0 ? .045 : -.045)));
                seg([rx, ry + RH, rz], [px, y + RH, sideZ]);
              } else if (side === 'both') {                     // 双跑梯井内侧：跨过两跑间隙，在平台接入边接上短扶手
                const zA = z0 + W, zB = z1 - W;
                const zLink = zB > zA ? Math.max(zA, Math.min(zB, rz)) : (z0 + z1) / 2;
                seg([rx, ry + RH, rz], [edge, y + RH, zLink]);
              }
            });
            [[x0 + .045, x0], [x1 - .045, x1]].forEach(([xe, xa]) => {
              let free = [[z0 + .045, z1 - .045]];                          // 端边：扣掉梯段占的宽（起步 / 收尾的跑都算）
              lay.runs.forEach(r => {
                if (Math.abs(r.x0 / 1000 - xa) > .01 && Math.abs(r.x1 / 1000 - xa) > .01) return;
                const a = r.z / 1000 - W / 2, b = r.z / 1000 + W / 2;
                free = free.flatMap(([p, q]) => {
                  const out = [];
                  if (a > p) out.push([p, Math.min(a, q)]);
                  if (b < q) out.push([Math.max(b, p), q]);
                  return out.filter(([u, v]) => v - u > .12);
                });
              });
              free.forEach(([p, q]) => line(xe, p, xe, q, y, y));
            });
          });
        }
        archUp.add(g);
      });
      (state.rails || []).forEach(buildRail3D);               // 栏杆
      (state.beams || []).forEach(buildBeam3D);               // 梁
      (state.slabs || []).forEach(buildSlab3D);               // 楼板 / 挑板
      (state.parapets || []).forEach(p => { const s0 = archUp.children.length; buildParapet3D(p); markNew(s0, 'parapet', p.id); });   // 女儿墙
      (state.canopies || []).forEach(buildCanopy3D);          // 雨棚
      if (!skipLift3D) (state.lifts || []).forEach(buildLift3D);   // 整栋视图：轿厢只在当前层生成一次，其它层只保留门洞呼叫面板
      (state.balconies || []).forEach(buildBalcony3D);        // 阳台
      (state.planters || []).forEach(buildPlanter3D);         // 花坛 / 种植池
      (state.flues || []).forEach(buildFlue3D);               // 烟道 / 风道
      (state.powerBoxes || []).forEach(b => buildBox3D('pbox', b));   // 强电箱
      (state.weakBoxes || []).forEach(b => buildBox3D('wbox', b));    // 弱电箱
      (state.lamps || []).forEach(buildLamp3D);               // 灯具 / 灯开关（夜景点光源）
      // 门洞、飘窗洞口上方过梁（飘窗属于原始户型：对应房间被清空 / 空方案时不建）
      const bayLintels = [
        state.rooms.bay1 && [[10270, 800, 10510, 2600], 2.4, null],
        state.rooms.bay2 && [[10270, 4260, 10510, 5740], 2.4, null],
      ].filter(Boolean);
      [...DOORS.map((d, i) => [bopenDoor(i).rect, 2.1, 'd' + i]), ...SLIDES.map((s, i) => [bopenRect('s' + i), s.v ? 2.4 : 2.1, 's' + i]), ...bayLintels]
        .forEach(([r, h, id]) => { if (id && (bopenRemoved(id) || bopenOnDeadWall(id))) return; if (top > h) wallBox(r, h, top); });
      WINS.forEach((r0, i) => {
        const s0 = archUp.children.length;
        if (bopenRemoved('w' + i) || bopenOnDeadWall('w' + i)) return;
        const r = bopenRect('w' + i);
        const sill = i === 0 ? 1.4 : i >= 6 ? .45 : .9, head = 2.4;
        const band = top > head && (state.bover['w' + i] || {}).grille === true;   // 窗花：窗上亮子玻璃带
        wallBox(r, 0, Math.min(sill, top)); if (top > head && !band) wallBox(r, head, top);
        colliders.push([wx(r[0]), wz(r[1]), wx(r[2]), wz(r[3]), 0, Math.min(sill, top)]);   // 窗下墙：矮窗台能跨过，高窗台仍挡人
        const gTop = Math.min(head, top); if (gTop <= sill) return;
        const [x0, y0, x1, y1] = r, hz = (x1 - x0) >= (y1 - y0), L = M(hz ? x1 - x0 : y1 - y0), gh = gTop - sill, cx = wx((x0 + x1) / 2), cz = wz((y0 + y1) / 2);
        if (band) {                                            // 亮子：横向带框固定玻璃（替代洞口上段实墙）
          const thM = Math.max(.15, ((state.bover['w' + i] || {}).th ?? Math.round((top - head) * 1000)) / 1000);   // 窗花高度可调，缺省顶到墙顶
          const bTop = Math.min(head + thM, top), bh = bTop - head;
          if (bh > .02) {
            const bpane = new THREE.Mesh(new THREE.BoxGeometry(hz ? L : .012, bh, hz ? .012 : L), glassMat);
            bpane.position.set(cx, head + bh / 2, cz); archUp.add(bpane);
            [head + .025, bTop - .025].forEach(y => { const bar = new THREE.Mesh(new THREE.BoxGeometry(hz ? L : .06, .05, hz ? .06 : L), frameMat); bar.position.set(cx, y, cz); archUp.add(bar); });
            [-L / 2 + .025, L / 2 - .025].forEach(t => { const bar = new THREE.Mesh(new THREE.BoxGeometry(hz ? .06 : .05, bh, hz ? .05 : .06), frameMat); bar.position.set(hz ? cx + t : cx, head + bh / 2, hz ? cz : cz + t); archUp.add(bar); });
          }
          if (top > bTop) wallBox(r, bTop, top);               // 亮子上方剩余墙段
        }
        const pane = new THREE.Mesh(new THREE.BoxGeometry(hz ? L : .01, gh, hz ? .01 : L), glassMat); pane.position.set(cx, sill + gh / 2, cz); archUp.add(pane);
        const n = Math.max(1, Math.round(L / .9));
        for (let k = 0; k <= n; k++) {                         // 窗扇竖向分格竖梃（固定样式）
          const t = -L / 2 + k * L / n, mu = new THREE.Mesh(new THREE.BoxGeometry(hz ? .04 : .06, gh, hz ? .06 : .04), frameMat);
          mu.position.set(cx + (hz ? t : 0), sill + gh / 2, cz + (hz ? 0 : t)); mu.castShadow = true; archUp.add(mu);
        }
        [sill + .02, gTop - .02].forEach(y => { const tr = new THREE.Mesh(new THREE.BoxGeometry(hz ? L : .06, .04, hz ? .06 : L), frameMat); tr.position.set(cx, y, cz); archUp.add(tr); });
        markNew(s0, 'bopen', 'w' + i);
      });
      DOORS.forEach((d0, i) => {
        const s0 = archUp.children.length;
        if (bopenRemoved('d' + i) || bopenOnDeadWall('d' + i)) return;
        const d = bopenDoor(i);
        const [rx0, ry0, rx1, ry1] = d.rect, hzD = LONG(d.rect);
        const PA = hzD ? [rx0, (ry0 + ry1) / 2] : [(rx0 + rx1) / 2, ry0];          // 门洞两端（墙中线）
        const PB = hzD ? [rx1, (ry0 + ry1) / 2] : [(rx0 + rx1) / 2, ry1];
        const inset = Math.min(60, d.len * .1);                                     // 门套占位：门扇两端各让出 60mm
        const pivot = new THREE.Group(), L = M(d.len - inset * 2), dh = Math.min(2.05, top);
        pivot.position.set(wx(d.h[0] + d.c[0] * inset), 0, wz(d.h[1] + d.c[1] * inset));
        const leaf = box(L, dh, .04, mat(isEntry('d' + i) ? '#6b4f3a' : '#efe6d8', { roughness: .5 }), L / 2);
        const knob = new THREE.Mesh(new THREE.SphereGeometry(.03, 12, 8), metal()); knob.position.set(L - .07, Math.min(1, dh - .05), 0); knob.scale.z = 2.2;
        pivot.add(leaf, knob);
        const ang = v => Math.atan2(-v[1], v[0]), door = { pivot, a0: ang(d.c), a1: ang(d.o), open: true };
        if (door.a1 - door.a0 > Math.PI) door.a1 -= Math.PI * 2; if (door.a0 - door.a1 > Math.PI) door.a1 += Math.PI * 2;
        door.cur = door.a1; pivot.rotation.y = door.cur; leaf.userData.door = knob.userData.door = door;
        doors.push(door); archUp.add(pivot);
        addDoorCasing(PA, PB, 0, Math.max(dh, Math.min(2.1, top)), hzD ? ry1 - ry0 : rx1 - rx0, isEntry('d' + i) ? entryCasingMat : casingMat);   // 原始门同样加门套，入户门用同色门套，顶到 2.1 遮挡门扇上方的缝隙
        markNew(s0, 'bopen', 'd' + i);
      });
      SLIDES.forEach((s0, i) => {
        const s0c = archUp.children.length;
        if (bopenRemoved('s' + i) || bopenOnDeadWall('s' + i)) return;
        const [x0, y0, x1, y1] = bopenRect('s' + i), v = s0.v;
        const L = M(v ? y1 - y0 : x1 - x0), ph = Math.min(v ? 2.4 : 2.1, top), pl = L * .55;
        const bdoor = { slide: true, open: false, cur: 0, pivots: [] };   // 与自画推拉门一致：门扇可点开合、关闭时挡路（原先用原始玻璃材质，pick() 跳过、无门对象 → 点不到也永远关着）
        const sg = oneMat(glassMat.clone());                              // 克隆玻璃材质才能参与拾取
        const ux = v ? 0 : (wx(x1) - wx(x0)) / L, uz = v ? (wz(y1) - wz(y0)) / L : 0;   // 门洞方向（世界系单位向量）
        [-1, 1].forEach(s => {
          const c = s < 0 ? -L / 2 + pl / 2 : L / 2 - pl / 2, off = s * .02;   // 双轨道：两扇沿墙厚各偏一侧
          const pg = new THREE.Group();
          pg.position.set(v ? wx((x0 + x1) / 2) + off : wx(x0) + L / 2 + c, 0, v ? wz(y0) + L / 2 + c : wz((y0 + y1) / 2) + off);
          const p = new THREE.Mesh(new THREE.BoxGeometry(v ? .02 : pl, ph, v ? pl : .02), sg); p.position.y = ph / 2; pg.add(p);
          [ph - .03, .03].forEach(y => { const fr = new THREE.Mesh(new THREE.BoxGeometry(v ? .04 : pl, .05, v ? pl : .04), frameMat); fr.position.y = y; fr.userData.door = bdoor; pg.add(fr); });
          [-1, 1].forEach(e => {
            const fr = new THREE.Mesh(new THREE.BoxGeometry(.04, ph, .04), frameMat);
            fr.position.set(v ? 0 : e * pl / 2, ph / 2, v ? e * pl / 2 : 0); fr.userData.door = bdoor; pg.add(fr);
          });
          bdoor.pivots.push({ g: pg, px: pg.position.x, pz: pg.position.z, ax: -ux * s, az: -uz * s, dist: L / 2, pw: pl });   // 点哪扇哪扇滑向对面
          p.userData.door = pg.userData.door = bdoor;
          archUp.add(pg);
        });
        doors.push(bdoor);
        markNew(s0c, 'bopen', 's' + i);
      });
      applyLight(); applyGrow();
      syncCeilSide(opt.mode);                                        // 重建后按当前模式设置天花单 / 双面
      doors.forEach(d => { if (!d.win && d.y0 === undefined) { d.y0 = 0; d.y1 = H; } });   // 门扇缺 y 区间时补成本层 0~层高：整栋漫游下配合数据集 ±0.6m 窗口，防止门扇全高串层挡人
      activeDoors = doors.slice(); activeLampGlowMats = lampGlowMats.slice();
      activeEscSteps = escSteps.slice(); activeRevolveSpins = revolveSpins.slice();   // 供整栋视图重建时还原当前层，再合并其它层
    }

    function buildFurn() {
      clearGroup(furnG);
      const built = state.furniture.map(f => { const g = buildFurniture(f); furnG.add(g); return { f, g }; });
      furnCols = [];                                              // 家具碰撞外接盒（世界矩形 + 高度区间，米）：随家具重建同步刷新
      const SKIP = { rug: 1, tv: 1, acwall: 1, waterheater: 1, chicken: 1, duck: 1, goose: 1, rabbit: 1, squirrel: 1, hedgehog: 1, fox: 1, tortoise: 1, deer: 1, cat: 1, dog: 1, hamster: 1, petrabbit: 1, parrot: 1, sheep: 1, goat: 1, pig: 1, cow: 1, horse: 1, donkey: 1, wolf: 1, raccoon: 1, frog: 1, kangaroo: 1, ostrich: 1, penguin: 1, snake: 1 };  // 地毯贴地可踩；电视 / 挂式空调 / 热水器为壁挂高位物；家禽与动物位置动态（漫步中按实时位置挡人），静态外接盒会把它们钉死在放置点，故跳过
      built.forEach(({ f, g }) => {
        const a = aabb(f), cx = wx(f.cx), cz = wz(f.cy), hw = a.hw / 1000 + .02, hh = a.hh / 1000 + .02;
        if (SKIP[f.type]) return;
        g.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(g), y0 = Number.isFinite(bb.min.y) ? bb.min.y : 0, y1 = Number.isFinite(bb.max.y) ? bb.max.y : 0;
        furnCols.push([cx - hw, cz - hh, cx + hw, cz + hh, y0, y1]);
      });
      furnG.visible = opt.furn; selKey = null; selHelpers.forEach(h => { scene.remove(h); h.geometry.dispose(); }); selHelpers = []; applyGrow();
    }

    function buildLabels() {
      labelG.children.slice().forEach(o => { o.element.remove(); labelG.remove(o); });
      allRooms().filter(r => state.rooms[r.id] && (r.at || r.id.startsWith('X'))).forEach(r => {
        const el = document.createElement('div'); el.className = 'rlabel';
        el.innerHTML = `${esc(nm(state.rooms[r.id].name))}<small>${area(r.poly).toFixed(1)}m²</small>`;
        const at = r.at || (() => { const b = bbox(r.poly); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; })();
        const o = new CSS2DObject(el); o.position.set(wx(at[0]), opt.cut + .15, wz(at[1])); o.visible = labelG.visible; labelG.add(o);
      });
      const counted = allRooms().filter(r => r.counted !== false && state.rooms[r.id]);
      $('#roomList').innerHTML = counted.map(r => `<button data-room="${r.id}"><span>${esc(nm(state.rooms[r.id].name))}</span><small>${area(r.poly).toFixed(2)} m²</small></button>`).join('')
        + `<button data-room="__all"><span>${tr('全屋', 'Whole home')}</span><small>${counted.reduce((a, r) => a + area(r.poly), 0).toFixed(2)} m²</small></button>`;
      document.querySelectorAll('#roomList button').forEach(b => b.onclick = () => {
        document.querySelectorAll('#roomList button').forEach(x => x.classList.toggle('on', x === b));
        if (opt.mode === 'walk') setMode('orbit');
        b.dataset.room === '__all' ? flyTo(isoWhole()) : flyToRoom(b.dataset.room);
      });
    }

    // 只重建变化的部分
    let sigRevLast = null, curA = '', curF = '', curL = '', curSF = '';
    function sync(force) {
      if (!inited || (!active && !force)) return;
      H = currentFloorH() / 1000;                                  // 当前层高（米）：墙体 / 天花 / 剖切都跟着层高
      if (opt.full && Math.abs(opt.cut - H) > 1e-6) { opt.cut = H; syncCutBtns(); }   // 全高墙模式：剖切高度始终贴当前楼层高度
      const revKey = window.stateRev + ' ' + opt.cut + ' ' + opt.slabs + ' ' + opt.allFloors + ' ' + ui.layers.ghost;
      if (force || revKey !== sigRevLast) {
        sigRevLast = revKey;
        // 数据版本号 / 视图开关未变时跳过下面 4 次全量 JSON.stringify（主循环每帧调用 sync，方案大时每帧序列化数白 KB 纯属浪费；
        // 未 bump 版本号的字段级变化——太阳能灯电量、信号灯相位、3D 拖动中的中间位置——由 applyLight / updateSolarVisuals / 松手 commit 直改或补齐，不需要重建）
        curA = JSON.stringify([state.rooms, state.roomsExtra, state.walls, state.arcWalls, state.openings, state.deletedWalls, state.demolished, state.entryDoor, state.wallH, state.bover, state.stairs, state.pillars, state.rails, state.beams, state.slabs, state.parapets, state.canopies, state.lifts, state.balconies, state.planters, state.flues, state.lamps, state.extras, state.roofs, state.pools, state.decks, state.pergolas, state.gates, state.powerBoxes, state.weakBoxes, opt.cut, H, ui.layers.ghost, opt.slabs, opt.allFloors]);
        curF = JSON.stringify(state.furniture);
        curL = JSON.stringify([state.rooms, opt.cut, H]);
        curSF = JSON.stringify([opt.allFloors, state.activeFloor, state.floors, state.byFloor, floorY()]);
      }
      const a = curA, f = curF, l = curL, sf = curSF;
      const rebuildArch = force || a !== sigArch, rebuildStack = force || sf !== sigStack;
      if (rebuildArch || rebuildStack) computeStackSkipSlabs();      // 整栋模式先算跨层楼板去重集合（含当前层），供 buildSlab3D 跳过重复板
      if (rebuildStack) { sigStack = sf; buildAllFloors(); }         // 先生成其它楼层，避免其 buildArch 清掉当前层的全局状态
      if (rebuildArch) { sigArch = a; buildFloorPlates(); buildArch(); }
      if (rebuildArch || rebuildStack) {
        mergeExtraWorldData();
        primaryCols = opt.allFloors ? normColsY(colliders, H) : null;   // 整栋模式下当前层碰撞也规范到本层 0~层高：站在其它层时当前层在 ±0.6m 窗口内仍会被检查，全高碰撞会在楼上挡人
        primaryFP = fpOf();                                        // 当前层足迹缓存（地板 / 房间区域 / 阳台），供足迹支撑判定
        if (ground) {                                              // 场地地面降到可见堆叠的最低处：否则不透明地面停在当前层楼板下 15mm，整栋模式会把下面整层埋住、下层参照也会被遮住
          const fs = state.floors || [], gi = fs.findIndex(f => f.id === state.activeFloor);
          const below = !opt.allFloors && ui.layers.ghost ? fs[gi - 1] : null;
          const lowZ = opt.allFloors && fs.length > 1 ? Math.min(...fs.map(f => f.z || 0)) : below ? (below.z || 0) : null;
          ground.position.y = lowZ === null ? -0.015 : lowZ / 1000 - floorY() - 0.015;
        }
      }
      if (force || f !== sigFurn) { sigFurn = f; buildFurn(); }
      if (force || l !== sigLabels) { sigLabels = l; buildLabels(); }
    }
    /* 下层幽灵：半透明显示紧邻下方的那一层墙体，作为当前层对位参照（漫游 / 碰撞 / 拾取都只针对当前层，不受影响） */
    let plateGroup = null, stackGroup = null;
    const GHOST_FLOOR_KEYS = ['walls', 'arcWalls', 'openings', 'deletedWalls', 'demolished', 'wallH', 'rooms', 'roomsExtra', 'bover', 'pillars'];
    function buildFloorPlates() {
      if (!scene) return;
      if (!ui.layers.ghost || opt.allFloors) {                      // 开关关闭，或整栋模式：整栋模式下其它楼层已经是完整真实几何，再做半透明幽灵墙只会重复叠加，下层比上层宽处露出一堆碎片
        if (plateGroup) { plateGroup.children.slice().forEach(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); plateGroup.remove(o); }); scene.remove(plateGroup); plateGroup = null; }
        return;
      }
      if (plateGroup) { plateGroup.children.slice().forEach(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); plateGroup.remove(o); }); scene.remove(plateGroup); }
      plateGroup = new THREE.Group(); scene.add(plateGroup);
      const base = floorY();
      const fs = state.floors || [], idx = fs.findIndex(f => f.id === state.activeFloor);
      const below = fs[idx - 1];                                    // 紧邻下方一层：切 2F 显示 1F，切 3F 显示 2F……
      if (!below) return;
      const data = state.byFloor[below.id]; if (!data) return;
      const dy = below.z / 1000 - base;                             // 下层相对当前层的标高差（负，米）：below.z 是 mm，base=floorY() 已是米
      // 临时把下层数据换入全局 state，复用墙体几何 helper（builtinSeg / wallSegs / cwGeom 都读 state）
      const saved = {}; GHOST_FLOOR_KEYS.forEach(k => saved[k] = state[k]);
      GHOST_FLOOR_KEYS.forEach(k => { state[k] = data[k] === undefined ? saved[k] : data[k]; });
      const ghostMat = new THREE.MeshStandardMaterial({ color: 0x8a97a8, transparent: true, opacity: .3, roughness: 1, depthWrite: false });
      const addGhost = (P0, P1, T, ht) => {                          // 半透明墙段（与 wallSeg3D 相同的中线与旋转算法）
        const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]); if (L < 1 || ht <= .001) return;
        const o = new THREE.Mesh(new THREE.BoxGeometry(M(L), ht, M(T)), ghostMat);
        const [mx, mz] = wallMid(P0, P1);
        o.position.set(mx, ht / 2, mz); o.rotation.y = wallAngle(P0, P1);
        plateGroup.add(o);
      };
      const ht = Math.max(.6, (below.h || 2800) / 1000);        // 幽灵墙按下层层高（不设 2.8 上限）：墙顶正好接到当前层楼板底，对位参照才准确
      try {
        WALLS.forEach((w, i) => {                                    // 内置墙
          const id = 'w' + i; if (state.deletedWalls.includes(id) || state.demolished.includes(id)) return;
          const s = builtinSeg(i);
          wallSegs(id, s.L).forEach(([c0, c1]) => { const [P0, P1] = segPts(s.A, s.B, c0, c1); addGhost(P0, P1, s.T, ht); });
        });
        (state.walls || []).forEach(w => {                          // 自画墙（含斜墙）
          const id = 'CW' + w.id; if (state.deletedWalls.includes(id) || state.demolished.includes(id)) return;
          const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
          wallSegs(id, L).forEach(([c0, c1]) => { const [P0, P1] = segPts(w.a, w.b, c0, c1); addGhost(P0, P1, cwT(w), ht); });
        });
      } finally { GHOST_FLOOR_KEYS.forEach(k => { state[k] = saved[k]; }); }
      plateGroup.position.y = dy;                                   // 整组下移到下层标高
      plateGroup.userData.ghostOf = below.id;
    }
    /* 全楼层漫游：其它楼层用完整几何按标高堆叠，并保存各层碰撞 / 楼梯 / 门数据 */
    function clearStackGroup() {
      if (!stackGroup) return;
      const geos = new Set(), mats = new Set();
      stackGroup.traverse(o => {
        if (o.geometry) geos.add(o.geometry);
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
        o.element?.remove?.();                                    // CSS2D 楼层标签要一并移除 DOM
      });
      geos.forEach(g => g.dispose()); mats.forEach(m => m.dispose());
      scene.remove(stackGroup); stackGroup = null;
    }
    function stackFloorBounds(data) {
      const pts = [];
      WALLS.forEach(w => pts.push([w[0], w[1]], [w[2], w[3]]));
      (data.walls || []).forEach(w => { if (w.a) pts.push(w.a); if (w.b) pts.push(w.b); });
      (data.arcWalls || []).forEach(w => { if (w.a) pts.push(w.a); if (w.b) pts.push(w.b); });
      if (!pts.length) pts.push([OX - 5000, OY - 5000], [OX + 5000, OY + 5000]);
      const xs = pts.map(p => +p[0] || 0), ys = pts.map(p => +p[1] || 0);
      return [Math.min(...xs) - 300, Math.min(...ys) - 300, Math.max(...xs) + 300, Math.max(...ys) + 300];
    }
    // 整栋模式跨层楼板去重：下层「层顶板 top」与紧邻上层的「地板 farea」若顶面同标高（下层 z+h == 上层 z，容差 5mm）
    // 且 X/Z 范围高度重合（重叠面积 ≥ 较小板的 90%），视为同一块楼板的重复绘制，跳过下层 top，只保留上层地板——
    // 消除顶面共面 z-fighting 与侧面双倍厚度板带。单层模式不去重（单层没有跨层重叠）。
    function computeStackSkipSlabs() {
      stackSkipSlabs = new Set();
      if (!opt.allFloors) return;
      const fs = state.floors || [];
      const dataOf = f => (f.id === state.activeFloor ? state : (state.byFloor?.[f.id] || {}));
      const slabsOf = f => (dataOf(f).slabs || []);
      const overlapRatio = (a, b) => {                    // 两块矩形 XZ 平面的重叠面积 / 较小板面积
        const ax0 = a.x - a.w / 2, ax1 = a.x + a.w / 2, az0 = a.y - a.d / 2, az1 = a.y + a.d / 2;
        const bx0 = b.x - b.w / 2, bx1 = b.x + b.w / 2, bz0 = b.y - b.d / 2, bz1 = b.y + b.d / 2;
        const ox = Math.min(ax1, bx1) - Math.max(ax0, bx0), oz = Math.min(az1, bz1) - Math.max(az0, bz0);
        if (ox <= 0 || oz <= 0) return 0;
        const area = ox * oz, small = Math.min(a.w * a.d, b.w * b.d) || 1;
        return area / small;
      };
      for (let i = 0; i + 1 < fs.length; i++) {
        const lo = fs[i], hi = fs[i + 1];
        if (Math.abs(((lo.z || 0) + (lo.h || 0)) - (hi.z || 0)) > 5) continue;   // 顶面不同标高：楼层间有空隙，不是同一块板
        const tops = slabsOf(lo).filter(s => s.top && !s.well);
        const floors = slabsOf(hi).filter(s => s.farea && !s.well);
        tops.forEach(t => floors.forEach(fl => { if (overlapRatio(t, fl) >= .9) stackSkipSlabs.add(t.id); }));
      }
    }
    function buildAllFloors() {
      clearStackGroup(); floorWorlds = []; extraGroups = []; primaryCols = null; stackDisp.clear();   // 旧楼层面板随场景一起失效，重新构建时重注册
      if (!scene || !opt.allFloors) return;
      const fs = state.floors || []; if (fs.length < 2) return;    // 单层无需堆叠，当前层已有完整几何
      stackGroup = new THREE.Group(); scene.add(stackGroup);
      const base = floorY();
      const sg = { archFloor, archUp, furnG, labelG, lampG };
      const ss = {}; FLOOR_KEYS.forEach(k => ss[k] = state[k]);
      const sH = H, sCut = opt.cut, sGrow = grow, sFGrow = furnGrow, sSkip = skipLift3D;
      const sBuildFH = window.__buildFloorH || 0;                 // 构建其它楼层期间「跟随层高」的取值基准，finally 还原为 0（当前层按 state.activeFloor）
      const sDoors = activeDoors, sLampGlowMats = activeLampGlowMats, sEscSteps = activeEscSteps, sRevolveSpins = activeRevolveSpins;
      const sCols = colliders, sFurnCols = furnCols, sBarriers = barriers, sSills = sills, sRevHit = revolveHit;   // buildArch / buildFurn 会重置这些全局碰撞数组，构建其它层后必须还原，否则当前层碰撞被其它层墙体覆盖（1F 被 2F 宽度挡住的根因）
      const sRides = new Map(liftRides), sDisp = new Map(liftDisp);   // buildArch 里 liftRides.clear() 会清掉电梯运行态，一并保住
      try {
        skipLift3D = true; grow = 1; furnGrow = 1;                 // 其它楼层按完整高度生成，不走过场动画缩放
        const minZ = Math.min(...fs.map(f => f.z || 0));
        fs.forEach(f => {
          if (f.id === state.activeFloor) return;                  // 当前层由 sync() 里的 buildArch 生成，保持可编辑
          const data = state.byFloor?.[f.id]; if (!data) return;
          const y0 = f.z / 1000 - base, fh = Math.max(1.2, (f.h || 2800) / 1000);
          const holder = new THREE.Group(); holder.position.y = y0; stackGroup.add(holder);
          const ag = { archFloor: new THREE.Group(), archUp: new THREE.Group(), furnG: new THREE.Group(), labelG: new THREE.Group(), lampG: new THREE.Group() };
          holder.add(ag.archFloor, ag.archUp, ag.furnG, ag.labelG, ag.lampG);
          archFloor = ag.archFloor; archUp = ag.archUp; furnG = ag.furnG; labelG = ag.labelG; lampG = ag.lampG;
          FLOOR_KEYS.forEach(k => { state[k] = data[k] === undefined ? ss[k] : data[k]; });
          H = fh; opt.cut = fh;                                    // 其它层按整层高度生成真实墙体 / 天花
          window.__buildFloorH = f.h || 2800;                      // 该层「跟随层高」的取值基准（mm）：天花 / 吊灯杆 / 门洞墙高 / 无高度弧形墙都按本层定义，不再串用当前编辑层的层高
          stackDefaultFloors = true;                               // 无样式房间也按默认材质生成楼板 / 天花：上层仰视不再是空的
          buildArch(); buildFurn();
          stackDefaultFloors = false;
          doors.forEach(d => { d.yOff = y0; });                    // 其它楼层门的 y0/y1/base/top 都是本层局部值，联动 / 光幕 / 感应按世界高度判定时统一加上该层偏移
          floorWorlds.push({
            id: f.id, y0, h: fh, primary: false, baseSupport: (f.z || 0) <= minZ + 1e-6,   // 底层整片可走，上层只在建筑足迹内
            stairs: (state.stairs || []).slice(), colliders: normColsY(colliders, fh), furnCols: furnCols.slice(),
            barriers: barriers.slice(), sills: sills.slice(), revolveHit: revolveHit.slice(),
            rooms: fpRooms(), areaRects: fpRects(), topRects: fpTopRects(), balc: fpBalconies(), holes: fpHoles(),   // 该层足迹（地板 / 层顶楼板 / 房间多边形 / 阳台 / 楼梯电梯井洞口），此时 state 已换成该层
            doors: doors.slice(), lampGlowMats: lampGlowMats.slice(),
            escSteps: escSteps.slice(), revolveSpins: revolveSpins.slice(), groups: ag
          });
          extraGroups.push(ag);
          const b = stackFloorBounds(data);
          const el = document.createElement('div');
          el.textContent = f.name || tr('楼层', 'Floor');
          el.style.cssText = 'padding:2px 7px;border-radius:6px;background:rgba(22,28,38,.72);color:#fff;font:600 11px/1.5 system-ui,sans-serif;white-space:nowrap;pointer-events:none';
          const lab = new CSS2DObject(el); lab.position.set(wx(b[0]), fh + .18, wz(b[1])); lab.visible = true; holder.add(lab);
        });
      } finally {
        skipLift3D = sSkip;
        archFloor = sg.archFloor; archUp = sg.archUp; furnG = sg.furnG; labelG = sg.labelG; lampG = sg.lampG;
        FLOOR_KEYS.forEach(k => { state[k] = ss[k]; });
        H = sH; opt.cut = sCut; grow = sGrow; furnGrow = sFGrow;
        window.__buildFloorH = sBuildFH;                            // 还原：当前层几何与 2D 面板仍按 state.activeFloor 的层高
        colliders = sCols; furnCols = sFurnCols; barriers = sBarriers; sills = sSills; revolveHit = sRevHit;   // 还原当前层碰撞数组：worldDatasets() 主数据集直接引用它们
        liftRides.clear(); sRides.forEach((v, k) => liftRides.set(k, v));
        liftDisp.clear(); sDisp.forEach((v, k) => liftDisp.set(k, v));
        activeDoors = sDoors; activeLampGlowMats = sLampGlowMats;
        activeEscSteps = sEscSteps; activeRevolveSpins = sRevolveSpins;   // buildArch 生成其它层会覆盖这些记录；退出整栋模式必须还原当前层
        stackDefaultFloors = false;
      }
    }
    function worldDatasets() {
      const list = [{
        id: state.activeFloor, y0: 0, h: H, primary: true, baseSupport: !opt.allFloors || isGroundFloor(state.activeFloor),
        stairs: state.stairs || [], colliders: primaryCols || colliders, furnCols, barriers, sills, revolveHit,
        rooms: primaryFP ? primaryFP.rooms : undefined, areaRects: primaryFP ? primaryFP.rects : undefined, topRects: primaryFP ? primaryFP.topRects : undefined, balc: primaryFP ? primaryFP.balc : undefined, holes: primaryFP ? primaryFP.holes : undefined,
        doors: activeDoors, groups: { furnG }
      }];
      if (opt.allFloors) list.push(...floorWorlds);
      return list;
    }
    function mergeExtraWorldData() {                             // 全局数组 = 当前层 + 其它楼层；每次都从当前层重建，避免重复 / 串层
      doors.length = 0; doors.push(...activeDoors);
      lampGlowMats.length = 0; lampGlowMats.push(...activeLampGlowMats);
      escSteps.length = 0; escSteps.push(...activeEscSteps);
      revolveSpins.length = 0; revolveSpins.push(...activeRevolveSpins);
      if (!floorWorlds.length) return;
      floorWorlds.forEach(w => {
        doors.push(...w.doors); lampGlowMats.push(...w.lampGlowMats);
        escSteps.push(...w.escSteps); revolveSpins.push(...w.revolveSpins);
      });
    }
    /* 楼层切换后由 2D 侧调用：重置签名强制 3D 重建（新层的构件 / 层高不同） */
    function onFloorChanged() { if (inited && active) { H = currentFloorH() / 1000; sigArch = sigFurn = sigLabels = ''; sync(true); if (opt.allFloors && opt.mode === 'orbit') flyTo(allFloorsPose()); } }

    // CSS2DRenderer 只看标签自身的 visible，不继承父级，所以逐个设置
    function showLabels(v) { labelG.visible = v; labelG.children.forEach(o => o.visible = v); }
    function applyGrow() {
      if (!inited) return;
      archUp.scale.y = Math.max(grow, .001);
      furnG.scale.y = Math.max(furnGrow, .001);
      lampG.visible = grow > .99;
    }

    /* ======================= 日照 / 夜景 ======================= */
    function applyLight() {
      const t = (opt.hour - 6) / 12, az = Math.PI * (.15 + t * .7), el = Math.sin(Math.PI * t) * 1.05 + .15, warm = 1 - Math.sin(Math.PI * t);
      sun.position.set(Math.cos(az) * 18, Math.sin(el) * 20 + 3, -Math.sin(az) * 10 + 8); sun.target.position.set(0, 0, 0);
      sun.color.setHSL(.09, .5 + warm * .4, .92 - warm * .12);
      sun.intensity = opt.night ? .05 : 1.4 + Math.sin(Math.PI * t) * 1.6;
      hemi.intensity = opt.night ? .12 : 1.1;
      scene.background = new THREE.Color(opt.night ? 0x1c2130 : 0xf7f4ee);
      ground.material.color.set(opt.night ? 0x2a2e38 : 0xf2eee7);
      const refOn = rf => rf?.on !== false && !(rf?.type === 'solarlamp' && (rf.battery ?? 0) <= 0);   // 太阳能路灯没电时强制视为灭
      lampG.children.forEach(o => {
        const rf = o.userData.lampRef, on = refOn(rf);                       // 房间自带吸顶灯无 lampRef，始终视为开
        if (o.isPointLight) {
          // 路灯挂得高（默认 8m），旧的点光源强度只有十几坎德拉，落到地面只剩"底座微微亮"；按半径提高到可见照度
          if (rf?.type === 'streetlamp' || rf?.type === 'solarlamp') o.intensity = opt.night && on ? Math.max(180, (rf.r || 12000) / 1000 * 55) : 0;
          else if (rf?.type === 'sanRestRoom') o.intensity = on ? (opt.night ? 9 : 5) : 0;   // 环卫休息室室内灯：白天 / 夜景开灯都照亮室内，透窗可见（不跟普通灯的"仅夜景亮"）
          else o.intensity = opt.night && on ? (rf ? 3 + (rf.r || 3000) / 1000 * 1.1 : 6) : 0;
        } else if (o.material?.emissiveIntensity !== undefined) o.material.emissiveIntensity = on ? (opt.night ? 2 : 1) : .05;
      });
      lampGlowMats.forEach(m => {                                // 灯泡 / 灯头自发光：开灯即亮（白天略弱），灯头按 glowFactor 再减弱
        const rf = m.userData.lampRef;
        const gr = m.userData.gangRef;                           // 多联开关指示灯：按该联受控灯是否都亮决定亮灭
        let on;
        if (gr) {
          const ts = switchTargets(gr.sw, gr.gang);
          on = ts.length > 0 && ts.every(x => x.on !== false);
        } else on = refOn(rf);
        if (m.userData.isHalo || m.userData.isPool) {            // 路灯灯头光晕 / 地面光斑：夜景明显，白天光晕弱、光斑关闭，关灯全灭
          m.opacity = on ? (opt.night ? (m.userData.isPool ? .62 : .9) : (m.userData.isPool ? 0 : .28)) : 0;
          m.visible = m.opacity > .005;
          return;
        }
        m.emissiveIntensity = (on ? (opt.night ? 2.4 : 1.2) : .05) * (m.userData.glowFactor ?? 1);
      });
      renderer.toneMappingExposure = opt.night ? 1.25 : 1.05;
      envK = opt.night ? .15 : 1; matCache.forEach(m => { if (m.envMap) m.envMapIntensity = m.userData.env * envK; });
      const h = Math.floor(opt.hour), m = Math.round((opt.hour - h) * 60);
      $('#sunT').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    /* ======================= 相机位姿 / 动画 ======================= */
    const ease = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const clamp01 = t => Math.max(0, Math.min(1, t));
    const pose = (t, p) => ({ t, p });
    // 与当前 2D 视口完全重合的正俯视位姿：透视相机在该高度下，地面可视高度 = 2D 视口高度
    function planPose() {
      const cx = view.x0 + SW() / 2 / view.s, cy = view.y0 + SH() / 2 / view.s, visH = SH() / view.s / 1000;
      const dist = visH / 2 / Math.tan(FOV / 2 * Math.PI / 180), t = new THREE.Vector3(wx(cx), 0, wz(cy));
      return pose(t, new THREE.Vector3(t.x, dist, t.z + 1e-4));
    }
    function isoFrom(P) {
      const d = THREE.MathUtils.clamp(P.p.y, 5, 30), dir = new THREE.Vector3(.3, .82, .49).normalize();
      return pose(P.t.clone(), P.t.clone().addScaledVector(dir, d));
    }
    const isoWhole = () => pose(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5.5, 15.5, 10));
    const topWhole = () => pose(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 19, 1e-4));
    function allFloorsPose() {                                     // 整栋堆叠视图：镜头对准楼层堆叠中心，按总高度拉远
      const fs = (state.floors && state.floors.length) ? state.floors : [currentFloor()].filter(Boolean);
      const minZ = Math.min(...fs.map(f => f.z || 0)), maxTop = Math.max(...fs.map(f => (f.z || 0) + (f.h || 2800)));
      const cy = (minZ + maxTop) / 2000 - floorY(), height = Math.max(2, (maxTop - minZ) / 1000);
      const dir = new THREE.Vector3(5.5, 15.5, 10).multiplyScalar(Math.max(1, height / 6));
      const t = new THREE.Vector3(0, cy, 0);
      return pose(t, new THREE.Vector3(dir.x, cy + dir.y, dir.z));
    }
    const curPose = () => pose(orbit.target.clone(), camera.position.clone());
    // 以目标点为中心做球坐标插值：镜头沿弧线倾斜环绕，而不是直线穿越
    function camTween(A, B, e) {
      const t = A.t.clone().lerp(B.t, e);
      const sa = new THREE.Spherical().setFromVector3(A.p.clone().sub(A.t)), sb = new THREE.Spherical().setFromVector3(B.p.clone().sub(B.t));
      let dth = sb.theta - sa.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
      const s = new THREE.Spherical(sa.radius + (sb.radius - sa.radius) * e, sa.phi + (sb.phi - sa.phi) * e, sa.theta + dth * e);
      camera.position.copy(t).add(new THREE.Vector3().setFromSpherical(s)); camera.lookAt(t); orbit.target.copy(t);
    }
    function setPose(P) { camera.position.copy(P.p); orbit.target.copy(P.t); camera.lookAt(P.t); }
    function animate(dur, fn) { return new Promise(res => { anim = { t0: performance.now(), dur, fn, res }; }); }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    function flyTo(B, dur = 900) { fly = { t0: performance.now(), dur, A: curPose(), B }; }
    function flyToRoom(id) {
      const r = allRooms().find(r => r.id === id), xs = r.poly.map(p => p[0]), ys = r.poly.map(p => p[1]);
      const t = new THREE.Vector3(wx((Math.min(...xs) + Math.max(...xs)) / 2), .6, wz((Math.min(...ys) + Math.max(...ys)) / 2));
      const size = M(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
      const dir = camera.position.clone().sub(orbit.target).setY(0); if (dir.lengthSq() < .01) dir.set(.6, 0, .8); dir.normalize();
      const dist = size * 1.3 + 2.2;
      flyTo(pose(t, new THREE.Vector3(t.x + dir.x * dist * .7, dist * 1.05, t.z + dir.z * dist * .7)));
    }

    /* ======================= 进入 / 退出 3D ======================= */
    async function enter() {
      init(); active = true;
      opt.slabs = ui.layers.slab !== false;                      // 进 3D：楼板开关从图层设置还原
      { const b = document.querySelector('#toggles3d [data-t="slabs"]'); if (b) b.classList.toggle('on', opt.slabs); }
      renderer.setSize(SW(), SH()); labelRenderer.setSize(SW(), SH()); camera.aspect = SW() / SH(); camera.updateProjectionMatrix();
      sync(true);
      opt.mode = 'orbit'; orbit.enabled = false; showLabels(false);
      const A = planPose(), B = opt.allFloors ? allFloorsPose() : isoFrom(A);
      grow = 0; furnGrow = 0; applyGrow(); setPose(A);
      stage.classList.add('animating');
      startLoop(); renderer.render(scene, camera);
      stage.classList.add('is3d');                       // 交叉淡入：此刻 3D 画面与 2D 平面完全重合
      await wait(420);
      await animate(1700, t => {
        camTween(A, B, ease(clamp01(t / .85)));
        grow = ease(clamp01((t - .1) / .55));
        furnGrow = ease(clamp01((t - .45) / .5));
        applyGrow();
      });
      orbit.enabled = true; showLabels(opt.labels);
      stage.classList.remove('animating');
    }
    async function exit() {
      if (opt.mode === 'walk') {
        walkCtl.unlock(); stopTouchWalk(); $('#hint3d').textContent = HINT_ORBIT(); $('#walkOverlay').style.display = 'none'; $('#cross').style.display = 'none';
        $('#tools').style.visibility = ''; $('#sunPad').style.visibility = '';   // 恢复漫游时临时隐藏的工具条（从漫游直接切回 2D 也要恢复，否则「预览/测量/设计」一直不显示）
        const dir = new THREE.Vector3(); camera.getWorldDirection(dir); orbit.target.copy(camera.position).addScaledVector(dir, 3).setY(0); opt.mode = 'orbit'; syncModeBtns();
      }
      fly = null; orbit.enabled = false; showLabels(false); stage.classList.add('animating');
      const A = curPose(), B = planPose();
      await animate(1300, t => {
        camTween(A, B, ease(clamp01((t - .1) / .9)));
        furnGrow = 1 - ease(clamp01(t / .45));
        grow = 1 - ease(clamp01((t - .2) / .6));
        applyGrow();
      });
      stage.classList.remove('is3d');                    // 此刻 3D 已压平为正俯视，与 2D 重合后淡出
      await wait(450);
      active = false; cancelAnimationFrame(raf); raf = 0;
      stage.classList.remove('animating');
      grow = furnGrow = 1; applyGrow();
    }

    /* ======================= 选择 / 拾取 ======================= */
    const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
    let doorHiRef = null;                                          // init() 里创建的门悬停高亮层（供 pick 跳过）
    function pick(e) {
      if (!e) ptr.set(0, 0);
      else { const r = renderer.domElement.getBoundingClientRect(); ptr.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); }
      ray.setFromCamera(ptr, camera);
      const targets = [...(opt.furn ? [furnG] : []), archUp, archFloor];
      if (opt.allFloors) extraGroups.forEach(g => { targets.push(g.archUp, g.archFloor); if (opt.furn) targets.push(g.furnG); });
      const hits = ray.intersectObjects(targets, true);
      for (const h of hits) {
        let o = h.object;
        if ((o.material === glassMat && !o.userData.pickGlass) || o === doorHiRef) continue;   // 玻璃（门窗扇除外）与门悬停高亮层不参与拾取
        if (o.userData.walkOnly || o.isLine || o.isLineSegments) continue;   // 漫游棱线 / 踢脚线只是辅助显示，不挡拾取（否则关着的门永远拾取不到）
        let sel = null;                                                  // 沿父链找通用构件标记 / 家具
        for (let p = o; p && p !== scene; p = p.parent) {
          if (p.userData.pick3d) { sel = { ...p.userData.pick3d, ...(p.userData.gang != null ? { gang: p.userData.gang } : {}) }; break; }
          if (p.userData.fid) { sel = { fid: p.userData.fid }; break; }
        }
        if (o.userData.gateArm) return { gateArm: o.userData.gateArm, dist: h.distance, mesh: o, ...(sel || {}) };   // 道闸机机箱 / 闸杆：点击升降
        if (o.userData.carLamp) return { carLamp: o.userData.carLamp, dist: h.distance, mesh: o, ...(sel || {}) };   // 轿车前照灯：点击开关车灯
        if (o.userData.park) return { park: o.userData.park, dist: h.distance, mesh: o, id: o.userData.park.id, ...(sel || {}) };   // 停车场设备：升降柱 / 伸缩门 / 车位灯 / 充电桩
        if (o.userData.liftBtn) return { liftBtn: o.userData.liftBtn, dist: h.distance, mesh: o, ...(sel || {}) };   // 电梯呼叫面板按钮：楼层直达 / 开 / 关门
        if (o.userData.carWin) return { carWin: o.userData.carWin, dist: h.distance, mesh: o, ...(sel || {}) };   // 车门内侧玻璃升降按钮
        if (o.userData.door) return { door: o.userData.door, dist: h.distance, mesh: o, ...(sel || {}) };   // 门扇：开合同时带回所属门窗 / 电梯 / 院门，供选中
        if (o.userData.room) return { room: o.userData.room };
        if (o.userData.flagHandle) return { flagHandle: o.userData.flagHandle, dist: h.distance };   // 旗面升降手柄
        if (o.userData.flagId) return { flagSel: o.userData.flagId, dist: h.distance };                               // 旗杆杆身：点击选中（漫游距离判断需要 dist）
        if (sel) return { ...sel, dist: h.distance };
        continue;                                        // 未标记的对象不挡拾取，继续找后面的命中
      }
      return null;
    }
    // 屏幕点 → 地面（y = 0）上的户型坐标 mm；s = 该处每 mm 对应的屏幕像素，用于拖放时的幽灵图大小
    const ground0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    function groundAt(x, y) {
      if (!active || anim) return null;
      const r = renderer.domElement.getBoundingClientRect(), hit = new THREE.Vector3();
      ptr.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
      ray.setFromCamera(ptr, camera);
      if (!ray.ray.intersectPlane(ground0, hit) || hit.distanceTo(camera.position) > 60) return null;
      // 视线先碰到墙体（或飘窗台）时，落点取碰到的位置，而不是穿过墙落到看不见的墙后
      const wall = ray.intersectObjects([archUp, archFloor], true).find(h => h.object.material !== glassMat && h.object.visible);
      if (wall && wall.distance < hit.distanceTo(camera.position) - .01) hit.set(wall.point.x, 0, wall.point.z);
      const px = v => new THREE.Vector2(v.x * r.width / 2, v.y * r.height / 2), a = px(hit.clone().project(camera));
      const s = Math.max(a.distanceTo(px(hit.clone().add(new THREE.Vector3(1, 0, 0)).project(camera))),
        a.distanceTo(px(hit.clone().add(new THREE.Vector3(0, 0, 1)).project(camera)))) / 1000;
      return { x: hit.x * 1000 + OX, y: hit.z * 1000 + OY, s };
    }
    function updateSel() {                                       // 家具 / 墙 / 柱 / 楼梯等选中对象统一橙色包围盒
      if (m3dPreview || opt.mode === 'walk') {                   // 3D 预览 / 漫游态：不显示编辑用的选中包围盒（只看效果，进这些模式前残留的选中线也一并清掉）
        if (selHelpers.length) { selHelpers.forEach(h => { scene.remove(h); h.geometry.dispose(); }); selHelpers = []; selKey = ''; }
        return;
      }
      const key = ui.sel?.id != null ? ui.sel.kind + ':' + ui.sel.id : '';
      if (key !== selKey) {
        selKey = key;
        selHelpers.forEach(h => { scene.remove(h); h.geometry.dispose(); }); selHelpers = [];
        const targets = [];
        if (ui.sel?.kind === 'furn') {
          const g = furnG.children.find(g => g.userData.fid === ui.sel.id);
          if (g) targets.push(g);
        } else if (ui.sel?.id != null) {
          const lampKind = ui.sel.kind === 'extra' && ['streetlamp', 'solarlamp', 'traflight', 'facLaneLight'].includes(state.extras?.find(x => String(x.id) === String(ui.sel.id))?.type);   // 路灯 / 太阳能路灯 / 信号灯 / 车道灯：pick3d 用 type 作 kind，选中却是 extra，这里对齐
          archUp.children.forEach(o => {                         // 墙段可能有多块，全部高亮
            const t = o.userData.pick3d;
            if (t && String(t.id) === String(ui.sel.id) && (t.kind === ui.sel.kind || (lampKind && t.kind === state.extras.find(x => String(x.id) === String(ui.sel.id)).type))) targets.push(o);
          });
        }
        targets.forEach(o => { const h = new THREE.BoxHelper(o, 0xb5653a); scene.add(h); selHelpers.push(h); });
      }
      selHelpers.forEach(h => h.update());
    }

    /* ======================= 漫游 ======================= */
    // 触屏漫游：左下虚拟摇杆移动，在画面上拖动转向（iPad 不支持鼠标指针锁定）
    const HINT_ORBIT = () => COARSE ? tr('单指旋转 · 双指缩放 / 平移 · 点选家具后可拖动摆放 · 点门开关', '1 finger orbits · 2 fingers zoom / pan · select furniture to drag it · tap doors to open')
      : tr('左键旋转 · 右键平移 · 滚轮缩放 · 选中家具后拖动可摆放 · 点击门开关', 'Left-drag orbits · right-drag pans · scroll zooms · select furniture to drag it · click doors to open');
    const HINT_TOUCHWALK = () => tr('左下摇杆移动 · 推满跑动 · 拖动画面转向 · 点门开关', 'Joystick moves · push full to run · drag to look · tap doors to open');
    const HINT_WALK = () => tr('WASD 移动 · 鼠标转向 · Shift 跑动 · Ctrl 蹲下 · Z 切换趴下 · 空格跳跃 · E 开关门 · R 脱离卡死 · Esc 暂停', 'WASD moves · mouse looks · Shift runs · Ctrl crouches · Z toggles prone · Space jumps · E opens doors · R unstuck · Esc pauses');
    function syncHint3d() { $('#hint3d').textContent = opt.mode === 'orbit' ? HINT_ORBIT() : touchWalk ? HINT_TOUCHWALK() : HINT_WALK(); }
    let touchWalk = false;
    const joy = { x: 0, y: 0, id: null }, eul = new THREE.Euler(0, 0, 0, 'YXZ');
    function lookBy(dx, dy) {                               // 移动端漫游：拖动方向 = 转向方向（与手指同向）
      eul.setFromQuaternion(camera.quaternion);
      eul.y -= dx * .005; eul.x = THREE.MathUtils.clamp(eul.x - dy * .005, -1.35, 1.35);
      camera.quaternion.setFromEuler(eul);
    }
    function startTouchWalk() {
      touchWalk = true;
      $('#walkOverlay').style.display = 'none'; $('#joy').style.display = 'block'; $('#walkExit').style.display = 'block';
      syncHint3d();
    }
    function stopTouchWalk() {
      touchWalk = false; joy.x = joy.y = 0; joy.id = null; $('#joy i').style.transform = '';
      $('#joy').style.display = 'none'; $('#walkExit').style.display = 'none';
    }
    function bindJoystick() {
      const el = $('#joy'), knob = $('#joy i'), R = 50;
      const upd = e => {
        const r = el.getBoundingClientRect();
        let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        const L = Math.hypot(dx, dy); if (L > R) { dx *= R / L; dy *= R / L; }
        joy.x = dx / R; joy.y = dy / R; knob.style.transform = `translate(${dx}px,${dy}px)`;
      };
      el.addEventListener('pointerdown', e => { e.preventDefault(); joy.id = e.pointerId; el.setPointerCapture(e.pointerId); upd(e); });
      el.addEventListener('pointermove', e => { if (e.pointerId === joy.id) upd(e); });
      const end = e => { if (e.pointerId !== joy.id) return; joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    }
    function setMode(m) {
      if (anim) return;
      if (driveCar && m !== 'walk') exitCar();                  // 离开漫游（切鸟瞰 / 预览）时先下车并把车位置写回方案
      opt.mode = m; syncModeBtns();
      stuckT = 0; if (stuckTip) stuckTip.classList.remove('open');   // 切换模式时收起卡死提示
      if (m === 'walk') {
        window.select(null);
        proneOn = false;   // 进入漫游时恢复站立姿态
        if (opt.full && Math.abs(opt.cut - H) > 1e-6) { opt.cut = H; syncCutBtns(); sync(); }
        orbit.enabled = false; fly = null;
        walkRespawn();                                               // 从入户门外 1.8m 面向屋内出发
        $('#walkOverlay').style.display = 'flex';
        $('#tools').style.visibility = 'hidden';                       // 漫游中隐藏左上角模式切换
        $('#sunPad').style.visibility = 'hidden';                      // 漫游中隐藏右上角日照滑杆
        syncHint3d();
      } else {
        resetRunFx();                                              // 离开漫游：复位跑动 FOV / 起伏，鸟瞰相机不受残留视场角影响
        walkCtl.unlock(); stopTouchWalk(); orbit.enabled = true;
        $('#walkOverlay').style.display = 'none'; $('#cross').style.display = 'none';
        $('#tools').style.visibility = '';
        $('#sunPad').style.visibility = '';
        syncHint3d();
        orbit.target.set(0, 0, 0); flyTo(isoWhole());
      }
      showLabels(opt.labels && m === 'orbit');
      archUp.traverse(o => { if (o.userData.walkOnly) o.visible = m === 'walk'; });
      syncCeilSide(m);
    }
    // 天花：漫游时双面（站到楼梯上、比天花高时也能看到它是块楼板），鸟瞰时单面（俯视仍能看进房间）
    function syncCeilSide(m) {
      const side = m === 'walk' ? THREE.DoubleSide : THREE.FrontSide;
      archUp.traverse(o => {
        if (!o.userData.ceil || !o.material || o.material.side === side) return;
        o.material.side = side; o.material.needsUpdate = true;
      });
    }
    const _v1 = new THREE.Vector3();                             // blocked() 复用的临时向量（避免漫游每帧分配）
    const _v2 = new THREE.Vector3();                             // blocked() 复用的第二个临时向量（门扇世界端点 / 滑动方向）
    const WALK_STEP_OVER = .35;                                 // 碰撞体顶面低于脚底 + 这一步高时视作可踩踏 / 可跨过（与矮门槛、楼梯踏步同尺度）
    function addBarrier(ax, az, bx, bz, y0, y1, reach, stepOver) { // 扶手 / 围栏的带高度线段碰撞：reach 为水平挡人距离（米）；stepOver = 踢面类可跨步屏障（楼梯 / 坡道 / 扶梯的逐级踢面线），顶边低于可跨步高时不挡，保证逐级上下通行
      if (Math.hypot(bx - ax, bz - az) < .06) return;
      barriers.push([ax, az, bx, bz, Math.min(y0, y1), Math.max(y0, y1), reach ?? .12, stepOver]);
    }
    function blockedOne(x, z, r, footH, noPoultry, W) {
      const passByHeight = (y0, y1) => footH !== null && (footH + headH < y0 || footH > y1 || y1 <= footH + WALK_STEP_OVER);
      for (const c of W.colliders) {
        if (driveCar && c.carId === driveCar.id) continue;           // 驾驶中跳过本车整车碰撞，否则车一移动就把自己判为被挡
        const [x0, z0, x1, z1, y0 = -Infinity, y1 = Infinity] = c;
        if (passByHeight(y0, y1)) continue;
        if (x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r) return true;
      }
      for (const [x0, z0, x1, z1, y0 = -Infinity, y1 = Infinity] of W.furnCols) {
        if (passByHeight(y0, y1)) continue;
        if (x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r) return true;
      }
      for (const w of W.revolveHit) {
        if (footH !== null && (footH + headH < w.y0 || footH > w.y1)) continue;
        const dx = x - w.mx, dz = z - w.mz;
        if (dx * dx + dz * dz > (w.r + r) * (w.r + r)) continue;
        for (let k = 0; k < 3; k++) {
          const a = w.spin.rotation.y + k * Math.PI * 2 / 3, ux = Math.cos(a), uz = -Math.sin(a);
          const ex = w.mx + ux * w.r, ez = w.mz + uz * w.r;
          const vx = ex - w.mx, vz = ez - w.mz, len2 = vx * vx + vz * vz;
          const t = Math.max(0, Math.min(1, (dx * vx + dz * vz) / len2));
          if (Math.hypot(dx - vx * t, dz - vz * t) < r * .9) return true;
        }
      }
      if (footH !== null) for (const [ax, az, bx, bz, y0, y1, reach, so] of W.barriers) {
        if (footH + headH < y0 || y1 <= footH + WALK_STEP_OVER) continue;   // 顶边不高于脚底 + 一步高：站在上一层地面时，下层栏杆 / 梯身不再当空气墙拦人
        const vx = bx - ax, vz = bz - az, len2 = vx * vx + vz * vz;
        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
        if (Math.hypot(x - (ax + vx * t), z - (az + vz * t)) < reach) return true;
      }
      for (const d of W.doors) {
        if (footH !== null && (footH + headH < (d.y0 ?? -Infinity) || (d.y1 ?? Infinity) <= footH + WALK_STEP_OVER)) continue;   // 门扇顶面 ≤ 脚底 + 一步高：站在上一层地面时，下层门叶不再当空气墙拦人
        if (d.fold) {
          if (!d.open) {
            const p0x = d.mx + d.ax * d.s0, p0z = d.mz + d.az * d.s0;
            const vx = d.ax * (d.s1 - d.s0), vz = d.az * (d.s1 - d.s0);
            const t = Math.max(0, Math.min(1, ((x - p0x) * vx + (z - p0z) * vz) / (vx * vx + vz * vz)));
            if (Math.hypot(x - (p0x + vx * t), z - (p0z + vz * t)) < r * .8) return true;
          }
          continue;
        }
        if (d.slat) {
          if (!d.open) {
            const t = Math.max(-.5, Math.min(.5, ((x - d.mx) * d.ax + (z - d.mz) * d.az) / (d.ax ** 2 + d.az ** 2)));
            if (Math.hypot(x - (d.mx + t * d.ax), z - (d.mz + t * d.az)) < r * .8) return true;
          }
          continue;
        }
        if (d.slide) {
          if (!d.auto && d.open) continue;
          for (const p of d.pivots) {
            p.g.getWorldPosition(_v1);
            let ux, uz;                                              // 滑动方向：ew 已是世界系直接用；局部 ax/az 只乘父级世界旋转换算（门扇自身 rotation 是开合动画不动它；父级无旋转时保持原值）
            if (p.ew) { ux = p.ew[0]; uz = p.ew[1]; }
            else { _v2.set(p.ax, 0, p.az).transformDirection(p.g.parent.matrixWorld); ux = _v2.x; uz = _v2.z; }
            const hw = (p.pw ?? .9) / 2;
            let t = ((x - _v1.x) * ux + (z - _v1.z) * uz) / hw;
            t = Math.max(-1, Math.min(1, t));
            if (Math.hypot(x - (_v1.x + ux * hw * t), z - (_v1.z + uz * hw * t)) < r * .8) return true;
          }
          continue;
        }
        if (d.win) {
          if (d.open) continue;
          if (footH !== null && (footH + headH < (d.y0 ?? 0) || (d.y1 ?? 2.5) <= footH + WALK_STEP_OVER)) continue;
          const a = d.a0, px2 = d.pivot.position.x, pz2 = d.pivot.position.z, ln = d.len ?? .9;
          const ex2 = px2 + Math.cos(a) * ln, ez2 = pz2 - Math.sin(a) * ln;
          const t = clamp01(((x - px2) * (ex2 - px2) + (z - pz2) * (ez2 - pz2)) / ((ex2 - px2) ** 2 + (ez2 - pz2) ** 2));
          if (Math.hypot(x - (px2 + (ex2 - px2) * t), z - (pz2 + (ez2 - pz2) * t)) < r * .8) return true;
          continue;
        }
        d.pivot.updateWorldMatrix(true, false);                    // 门扇可能挂在带位移 / 旋转的父组下（设施门 / 院门）：读局部坐标会在错误位置挡人，改取门枢世界坐标 + 门扇世界端点
        _v1.setFromMatrixPosition(d.pivot.matrixWorld);
        const tip = _v2.set(d.len ?? .9, 0, 0).applyMatrix4(d.pivot.matrixWorld);
        const px = _v1.x, pz = _v1.z, ex = tip.x, ez = tip.z;
        const t = clamp01(((x - px) * (ex - px) + (z - pz) * (ez - pz)) / ((ex - px) ** 2 + (ez - pz) ** 2));
        if (Math.hypot(x - (px + t * (ex - px)), z - (pz + t * (ez - pz))) < r * .8) return true;
      }
      if ((footH === null || footH < .5) && !noPoultry && W.primary) for (const g of furnG.children) {
        if (!g.userData.poultry) continue;
        if (Math.hypot(x - g.position.x, z - g.position.z) < r + .15) return true;
      }
      return false;
    }
    function blocked(x, z, r = .22, footH = null, noPoultry = false) {
      for (const W of worldDatasets()) {
        if (footH !== null) {
          const local = footH - W.y0;                              // 世界 y → 该层局部 y
          if (local < -.6 || local > W.h + .6) continue;           // 只检查脚所在楼层及相邻半米
          if (blockedOne(x, z, r, local, noPoultry, W)) return true;
        } else if (blockedOne(x, z, r, null, noPoultry, W)) return true;
      }
      return false;
    }
    function poultryFree(x, z, self) {                            // 家禽能否走到 (x,z)：复用墙 / 家具 / 门扇 / 旋转门三翼 / 栏杆碰撞，按家禽小体型（半径 0.1m、高 0.3m）判高度，避免穿墙穿门穿家具、走出阳台；self 为自身组（家禽互相避让时排除）
      const r = .1;
      if (opt.mode === 'walk') {                                  // 漫游时不走向玩家所在位置，避免家禽钻进玩家身体
        const dxp = x - camera.position.x, dzp = z - camera.position.z;
        if (dxp * dxp + dzp * dzp < .45 * .45) return false;
      }
      for (const g of furnG.children) {                           // 家禽与家禽之间保持最小间距，互相不穿模（该步若在远离对方则放行，避免多只叠放在同一点时互相卡死谁也走不开）
        if (g === self || !g.userData.poultry) continue;
        const dxp = x - g.position.x, dzp = z - g.position.z;
        if (dxp * dxp + dzp * dzp < .28 * .28) {
          const dx0 = self.position.x - g.position.x, dz0 = self.position.z - g.position.z;
          if (dxp * dxp + dzp * dzp >= dx0 * dx0 + dz0 * dz0) continue;
          return false;
        }
      }
      for (const [x0, z0, x1, z1, y0 = -Infinity, y1 = Infinity] of colliders)
        if (y0 < .3 && y1 > 0 && x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r) return false;
      for (const [x0, z0, x1, z1, y0 = -Infinity, y1 = Infinity] of furnCols)
        if (y0 < .3 && y1 > 0 && x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r) return false;
      for (const [ax, az, bx, bz, y0, y1, reach] of barriers) {
        if (y0 >= .3 || y1 <= 0) continue;
        const vx = bx - ax, vz = bz - az, len2 = vx * vx + vz * vz;
        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
        if (Math.hypot(x - (ax + vx * t), z - (az + vz * t)) < reach + r) return false;
      }
      if (blockedOne(x, z, r, 0, true, worldDatasets()[0])) return false;   // 家禽只在当前层活动，复用门扇 / 三翼判定，不让它被其它楼层碰撞体挡住
      return true;
    }
    const liftRides = new Map();                                 // 电梯运行态：id → { from, to, base, ... }，漫游支撑高度与碰撞按 base 同步
    const liftLit = new Map();                                    // 已登记的目标层：id → Set<楼层索引>，面板上亮灯（到站熄灭）
    const liftDoorReq = new Map();                                // 层站呼叫来源：id → Map<楼层索引, 门洞 id>，到站只开被呼叫的那扇层门
    const liftGo = new Map();                                     // 到站后待续行：id → { tAt }，门关到位再出发去下一个目标层
    const liftDir = new Map();                                    // 运行方向：id → 1 上行 / -1 下行，用于顺向优先调度
    const liftDisp = new Map();                                  // 当前层电梯显示屏：id → [panel]（buildArch 每次重建都会 clear）
    const stackDisp = new Map();                                 // 整栋模式其它楼层门洞呼叫面板：id → [panel]，单独存，避免被当前层 buildArch 的 clear 清掉
    const liftAllDisp = id => [...(liftDisp.get(id) || []), ...(stackDisp.get(id) || [])];   // 该电梯全部面板：当前层 + 其它楼层
    const regLiftDisp = (id, panel) => {                         // 注册面板（门洞先于电梯构建，需按 id 惰性建表）；整栋模式构建其它楼层时写入 stackDisp
      if (id == null) return;
      const m = skipLift3D ? stackDisp : liftDisp;
      let a = m.get(id); if (!a) m.set(id, a = []);
      a.push(panel);
    };
    function stairHOne(x, z, ref, W, withLift) {
      const px = x * 1000 + 6000, py = z * 1000 + 5300;
      let cand;
      const hitRects = list => list.some(rc => x > rc[0] && x < rc[2] && z > rc[1] && z < rc[3]);
      if (W.baseSupport === false) {                            // 整栋漫游的非底层：楼面按足迹定义
        const fa = W.areaRects, balc = W.balc, rms = W.rooms;
        if (fa === undefined || rms === undefined) cand = [0];  // 足迹数据未就绪：退回旧行为，避免误坠
        else if (fa.length) {                                   // 画了地板：楼面 = 地板 ∪ 阳台（楼梯 / 电梯井洞口除外），没画到的位置就是悬空
          const inHole = (W.holes || []).some(h => x > h[0] && x < h[2] && z > h[1] && z < h[3]);
          cand = (inHole ? [] : (hitRects(fa) || (balc.length && hitRects(balc))) ? [0] : []);   // 洞口处不提供楼面支撑，由楼梯 / 电梯自身支撑
        }
        else if (rms.length || balc.length) {                   // 没画地板：退回房间区域 ∪ 阳台 ∪ 墙体等碰撞体（楼梯间 / 电梯井 / 板洞同样不支撑）
          const inHole = (W.holes || []).some(h => x > h[0] && x < h[2] && z > h[1] && z < h[3]);
          cand = (!inHole && (rms.some(p => pointInPoly(x, z, p)) || (balc.length && hitRects(balc)) || (W.colliders || []).some(c => c[6] !== 'water' && x > c[0] && x < c[2] && z > c[1] && z < c[3]))) ? [0] : [];
        } else cand = [0];                                      // 什么足迹都没有：整片可走
      } else cand = [0];                                        // 底层 / 单层模式整片可走
      if ((W.topRects || []).length) {                          // 层顶楼板：踩在本层层高上时可站立
        const inTopHole = (W.holes || []).some(h => x > h[0] && x < h[2] && z > h[1] && z < h[3]);
        // 楼梯间 / 电梯井 / 板洞是真实洞口：不铺虚拟落脚面。踩不到踏步 / 平台 / 轿厢就没有支撑，漫游会正常坠落。
        if (!inTopHole && hitRects(W.topRects)) cand.push(W.h ?? H);
      }
      (W.stairs || []).forEach(s => {
        const a = s.dir * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        const dx = px - s.x, dy = py - s.y, lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
        const lay = stairLayout(s);
        if (lay.spiral) {
          const dist = Math.hypot(dx, dy);
          if (dist > lay.rCore && dist < lay.rOuter) {
            const ca2 = Math.cos(a), sa2 = Math.sin(a);
            const lx2 = dx * ca2 + dy * sa2, ly2 = -dx * sa2 + dy * ca2;
            const phi = Math.atan2(lx2, ly2) - (s.flipX ? Math.PI : 0);
            const A = lay.ang, lo = Math.min(0, A), hi = Math.max(0, A), TAU = Math.PI * 2;
            const ang0 = lo + (((phi - lo) % TAU) + TAU) % TAU;
            for (let ang = ang0; ang <= hi + 1e-9; ang += TAU) cand.push((s.rise ?? 2800) * (ang / A) / 1000);
          }
          return;
        }
        lay.runs.forEach(r => {
          if (Math.abs(ly - r.z) > lay.w / 2) return;
          if (lx < Math.min(r.x0, r.x1) || lx > Math.max(r.x0, r.x1)) return;
          const t = r.dir > 0 ? (lx - r.x0) / (r.x1 - r.x0) : (r.x0 - lx) / (r.x0 - r.x1);
          cand.push((r.y0 + Math.max(0, Math.min(1, t)) * (r.y1 - r.y0)) / 1000);
        });
        lay.lands.forEach(L => {
          if (lx >= Math.min(L.x0, L.x1) && lx <= Math.max(L.x0, L.x1) && ly >= L.z0 && ly <= L.z1) cand.push(L.y / 1000 + (s.type === 'esc' ? .15 : 0));
        });
      });
      (W.sills || []).forEach(s => {
        const ax = s.x1 - s.x0, az = s.z1 - s.z0, L2 = ax * ax + az * az || 1;
        const t = ((px - s.x0) * ax + (py - s.z0) * az) / L2;
        if (t < 0 || t > 1) return;
        if (Math.abs((px - s.x0) * az - (py - s.z0) * ax) / Math.sqrt(L2) <= s.T / 2 + 120) cand.push(s.y);
      });
      (W.colliders || []).forEach(c => {                   // 墙顶 / 矮墙顶 / 窗台 / 台面可站立：碰撞体矩形内有支撑面，脚够得着（≤ 脚底 + .55m）就能踩上去——可从楼梯踏上墙顶、跳上矮墙 / 池沿
        if (c[6] === 'water') return;                      // 水体只挡人，不作支撑面
        const top = c.length >= 6 ? c[5] : (W.h ?? H);     // 4 元素旧式碰撞（墙等）没带高度，顶面 = 本层层高
        if (top <= .01) return;
        if (x > c[0] && x < c[2] && z > c[1] && z < c[3]) cand.push(top);
      });
      if (withLift) (state.lifts || []).forEach(l => {          // 电梯支撑面共用一套绝对停靠高度，换算到当前层基准
        const B = liftRides.has(l.id) ? liftRides.get(l.id).base : Math.max(0, (l.stop ?? 0) / 1000 - floorY());
        if (B <= .001) return;
        const th = -(l.dir || 0) * Math.PI / 180, ct = Math.cos(th), st = Math.sin(th);
        const dx = px - l.x, dy = py - l.y;
        const lx = dx * ct - dy * st, ly = dx * st + dy * ct;
        const hw = Math.max(800, l.w ?? 2000) / 2 + 120, hd = Math.max(800, l.d ?? 2000) / 2 + 120;
        if (Math.abs(lx) <= hw && Math.abs(ly) <= hd) cand.push(B);
      });
      const base = ref ?? 0, near = cand.filter(v => v <= base + .55);
      if (!near.length) return cand.length ? Math.min(...cand) : null;   // null = 此处无任何支撑（足迹外），由 stairH 合并时跳过
      return Math.max(...near);
    }
    function stairH(x, z, ref) {                                 // 支撑高度：合并各层楼梯 / 门槛，按世界标高就近取
      const worlds = worldDatasets();
      // 只认真实支撑（楼梯踏步 / 平台 / 楼面 / 墙顶 / 电梯轿厢）。楼梯间、电梯井、板洞是真实洞口，
      // 踩不到任何支撑就返回 0（无支撑），由 stepWalk 触发跌落——不再铺虚拟落脚面。
      let best = 0, bd = Infinity;
      const take = wy => { const d = ref == null ? Math.abs(wy) : Math.abs(wy - ref); if (d < bd) { bd = d; best = wy; } };
      worlds.forEach((W, i) => {
        const localRef = ref == null ? null : ref - W.y0;
        if (localRef != null && (localRef < -W.h - .5 || localRef > W.h + .5)) return;
        const h0 = stairHOne(x, z, localRef, W, i === 0);
        if (h0 === null) return;                               // 该数据集此处无支撑（足迹外）→ 走出楼外会自然坠落
        take(h0 + W.y0);
      });
      // 电梯轿厢：整栋共用支撑面，停靠高度是绝对标高，不随「当前层 ±0.6m」窗口取舍。
      // 否则从 1F 数据集里坐电梯上到 3F 时，1F 数据集被高度窗口排除，轿厢支撑跟着丢失，人一到站就踩空坠落。
      const px = x * 1000 + 6000, py = z * 1000 + 5300;
      (state.lifts || []).forEach(l => {
        const B = liftRides.has(l.id) ? liftRides.get(l.id).base : Math.max(0, (l.stop ?? 0) / 1000 - floorY());
        if (B <= .001) return;
        const th = -(l.dir || 0) * Math.PI / 180, ct = Math.cos(th), st = Math.sin(th);
        const dx = px - l.x, dy = py - l.y;
        const lx = dx * ct - dy * st, ly = dx * st + dy * ct;
        const hw = Math.max(800, l.w ?? 2000) / 2 + 120, hd = Math.max(800, l.d ?? 2000) / 2 + 120;
        if (Math.abs(lx) <= hw && Math.abs(ly) <= hd) take(B);
      });
      return best;                                             // 无支撑 → 0（落回场地地面）；洞口内无支撑同样按 0 处理
    }
    let jumpV = 0, jumpY = 0;                                    // 漫游跳跃：竖直速度 / 离地高度（视高 1.6m + jumpY）
    let fallV = 0, fallY = null;                                 // 跌落：竖直速度 / 当前支撑高度（null = 待初始化）
    let crouchT = 0;                                             // 姿态插值：0 站立 ~ 1 全蹲 ~ 2 趴下（Ctrl/C 按住蹲下、Z 切换趴下）
    let ladderOn = null;                                         // 攀梯状态：正在攀爬的那架梯子（null = 未攀爬）
    let proneOn = false;                                         // 趴下开关状态（Z 键切换：再按一次起身）
    let runAmt = 0, bobT = 0, bobY = 0;                          // 跑动效果：跑动强度 0~1（控 FOV 扩张与起伏幅度）/ 起伏相位 / 头部起伏高度（脚步节奏视感）
    const EYE_STAND = 1.6, EYE_CROUCH = .9, EYE_PRONE = .45;     // 站立视高 / 蹲下视高 / 趴下视高
    const HEAD_CROUCH = 1.15, HEAD_PRONE = .4;                   // 蹲下头顶高 / 趴下头顶高（站立头顶 1.6m）
    let eyeH = EYE_STAND, headH = EYE_STAND;                     // 当前视高 / 头顶高（随姿态插值，blocked() 判头高用）
    function postureHeights(t) {                                 // 姿态 → 视高 / 头顶高：0~1 站→蹲，1~2 蹲→趴
      if (t <= 1) { eyeH = EYE_STAND - (EYE_STAND - EYE_CROUCH) * t; headH = EYE_STAND - (EYE_STAND - HEAD_CROUCH) * t; }
      else { eyeH = EYE_CROUCH - (EYE_CROUCH - EYE_PRONE) * (t - 1); headH = HEAD_CROUCH - (HEAD_CROUCH - HEAD_PRONE) * (t - 1); }
    }
    let stuckT = 0;                                              // 卡死计时：持续有移动输入但两轴试探都被挡的累计秒数（松开移动键即清零）
    let stuckTip = null;                                         // 准星下方「脱离卡死」提示条（stepWalk 检测到卡死时显示；触屏可直接点它脱离）
    let driveCar = null;                                         // 驾驶状态：{ id, grp, col, L, Wd, BH, ang, speed }（null = 未驾驶；非 null 时 stepWalk 改由 stepDrive 接管）
    function syncRunFov(dt) {                                    // 跑动视野：FOV 随跑动强度扩张（走路 45° → 全速跑 52°），产生冲刺拉宽感
      const tf = FOV + runAmt * 7;
      camera.fov += (tf - camera.fov) * Math.min(1, dt * 5);
      if (Math.abs(camera.fov - tf) < .05) camera.fov = tf;
      camera.updateProjectionMatrix();
    }
    function resetRunFx() {                                      // 复位跑动视感：进出漫游 / 脱离卡死 / 下车时用，防止 FOV 或头部起伏残留
      runAmt = 0; bobT = 0; bobY = 0;
      if (Math.abs(camera.fov - FOV) > .05) { camera.fov = FOV; camera.updateProjectionMatrix(); }
    }
    function walkRespawn() {                                     // 回到入户门出生点：进入漫游与脱离卡死共用同一位置与朝向；全楼层模式固定在 1F
      resetRunFx();
      let eg = null, yOff = 0;
      const fs = state.floors || [];
      const first = fs.length ? fs.reduce((a, b) => ((b.z || 0) < (a.z || 0) ? b : a)) : null;   // 1F = 标高最低的楼层（与 isGroundFloor 同定义）
      if (opt.allFloors && first) {
        // 整栋模式世界高度以「当前编辑层」为 0，1F 位于其下方：出生高度 = 1F 标高 - 当前层标高（与 buildAllFloors 的 y0 同式）
        yOff = (first.z || 0) / 1000 - floorY();
        // 出生门几何也取 1F：临时把 1F 分层数据换到顶层复用 entryGeom（读全局 state），完事立即还原
        if (first.id === state.activeFloor) eg = entryGeom();
        else {
          const ss = {}; FLOOR_KEYS.forEach(k => ss[k] = state[k]);
          try {
            const d = state.byFloor?.[first.id];
            if (d) FLOOR_KEYS.forEach(k => { state[k] = d[k] === undefined ? ss[k] : d[k]; });
            eg = entryGeom();
          } finally { FLOOR_KEYS.forEach(k => { state[k] = ss[k]; }); }
        }
        fallY = yOff; jumpY = jumpV = fallV = 0;                 // 支撑高度对齐 1F，避免第一帧被当前编辑层的支撑高度拉走
      } else eg = entryGeom();
      if (eg) {
        camera.position.set(wx(eg.cx + eg.out[0] * 1800), yOff + 1.6, wz(eg.cy + eg.out[1] * 1800));
        camera.lookAt(wx(eg.cx), yOff + 1.5, wz(eg.cy));
      } else {
        camera.position.set(wx(4200), yOff + 1.6, wz(8755)); camera.lookAt(wx(7000), yOff + 1.5, wz(8755));   // 兜底：原始入户门外
      }
    }
    const carIdFromHit = h => {                                  // 从拾取结果里取出车辆 id（轿车 / 越野车车身 / 车门 / 车灯任一命中都算），非车辆返回 null
      if (!h) return null;
      if (h.door?.kind === 'car' && h.door.carId != null) return h.door.carId;
      if (h.carLamp != null) return h.carLamp;
      if (h.kind === 'extra' && h.id != null && isCar((state.extras || []).find(x => String(x.id) === String(h.id))?.type)) return h.id;
      return null;
    };
    function carFootBlocked(cx, cz, ang, L, Wd) {                 // 驾驶碰撞：按旋转后的车身矩形足迹取中心 + 四角试探，避开墙 / 家具 / 其它车
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const hw = (L*Math.abs(ca)+Wd*Math.abs(sa))/2, hd = (L*Math.abs(sa)+Wd*Math.abs(ca))/2;
      for (const [sx, sz] of [[0,0],[-1,-1],[-1,1],[1,-1],[1,1]]) if (blocked(cx + sx*hw, cz + sz*hd, .1, 0)) return true;
      return false;
    }
    function enterCar(id) {                                       // 上车：把相机移到左前驾驶位，登记 driveCar 后由 stepDrive 接管漫游物理
      const e = (state.extras || []).find(x => String(x.id) === String(id) && isCar(x.type)); if (!e) return false;
      const grp = archUp.children.find(o => o.userData.pick3d?.kind === 'extra' && String(o.userData.pick3d.id) === String(e.id)); if (!grp) return false;
      const col = colliders.find(c => c.carId === e.id);
      const def = FACILITY_DEFS[e.type];
      const L = Math.max(2.5, M(e.w || def.w)), Wd = Math.max(1.2, M(e.d || def.d)), BH = Math.max(1.1, M(e.h || def.h));
      const wr = e.type === 'carSuv' ? Math.min(.40, BH*.24) : Math.min(.33, BH*.22), y0 = wr*.82;
      driveCar = { id:e.id, grp, col, L, Wd, y0, ang:((+e.rot||0)%360)*Math.PI/180, speed:0, cx:grp.position.x, cz:grp.position.z };
      fallY = 0; jumpY = jumpV = fallV = 0; crouchT = 0; eyeH = EYE_STAND; headH = EYE_STAND; ladderOn = null; stuckT = 0;
      if (stuckTip) stuckTip.classList.remove('open');
      grp.updateMatrixWorld(true);
      const eye = grp.localToWorld(new THREE.Vector3(-L*.05, y0 + 1.0, -Wd*.22));   // 驾驶位眼高（坐姿，低于站立 1.6m），相机在座椅略靠后
      camera.position.copy(eye); camera.lookAt(eye.x + Math.cos(driveCar.ang), eye.y, eye.z + Math.sin(driveCar.ang));
      if (driveExit) driveExit.style.display = 'block';
      if (walkTip) { walkTip.textContent = touchWalk ? tr('点按「下车」退出', 'Tap "Exit" to get out') : tr('E / F 下车 · WASD 驾驶 · Shift 加速 · 空格刹车', 'E / F exit · WASD drive · Shift boost · Space brake'); walkTip.classList.add('open'); }
      toast(tr('已上车：WASD 驾驶，E / F 下车', 'In the car — WASD to drive, E / F to exit'));
      return true;
    }
    function exitCar(silent) {                                    // 下车：先把相机放到驾驶座旁空位，再把车辆最终位置 / 朝向一次性写回方案（可撤销、2D / 3D 同步）
      const d = driveCar; if (!d) return;
      d.grp.updateMatrixWorld(true);
      driveCar = null;                                            // 先退出驾驶：blocked() 这才会把本车碰撞体算进去，避免把落点选进车身里导致下车卡死
      resetRunFx();                                               // 复位驾驶 / 跑动的 FOV 与头部起伏残留
      if (driveExit) driveExit.style.display = 'none';
      if (walkTip) walkTip.classList.remove('open');
      fallY = 0; jumpY = jumpV = fallV = 0; crouchT = 0; eyeH = EYE_STAND; headH = EYE_STAND;
      let spot = null;
      const side = d.Wd*.22 + .85, ends = [[0,-side],[-d.L*.22,-side],[d.L*.22,-side],[-d.L*.38,-side],[d.L*.38,-side],[0,side],[0,-side-.7]];
      for (const [lx, lz] of ends) {                              // 沿车身两侧逐档找真正空位（本车 / 墙 / 家具都挡），找不到回入户门
        const p = d.grp.localToWorld(new THREE.Vector3(lx, 0, lz));
        if (!blocked(p.x, p.z, .26, 0)) { spot = p; break; }
      }
      if (spot) { camera.position.set(spot.x, EYE_STAND, spot.z); camera.lookAt(d.cx, EYE_STAND, d.cz); }
      else walkRespawn();
      const e = (state.extras || []).find(x => String(x.id) === String(d.id));
      if (e) mutate(() => { e.x = Math.round(d.cx*1000 + OX); e.y = Math.round(d.cz*1000 + OY); e.rot = ((d.ang*180/Math.PI)%360+360)%360; });
      if (!silent) toast(tr('已下车', 'Out of the car'));
    }
    function stepDrive(dt) {                                      // 驾驶：油门 / 刹车 / 转向驱动车辆，车身 3D 与碰撞体逐帧直改、相机跟随驾驶位；不在每帧写 state（下车才一次性提交）
      const d = driveCar; if (!d) return;
      const throttle = (keys.KeyW||keys.ArrowUp ? 1 : 0) - (keys.KeyS||keys.ArrowDown ? 1 : 0) - (touchWalk ? joy.y : 0);
      const steer = (keys.KeyD||keys.ArrowRight ? 1 : 0) - (keys.KeyA||keys.ArrowLeft ? 1 : 0) + (touchWalk ? joy.x : 0);
      const brake = keys.Space ? 1 : 0, maxF = (keys.ShiftLeft||keys.ShiftRight) ? 9 : 6, maxR = 3;
      if (brake) d.speed *= Math.max(0, 1 - 8*dt);
      else if (throttle > 0) d.speed += (d.speed < 0 ? 7 : 4.5) * throttle * dt;
      else if (throttle < 0) d.speed += (d.speed > 0 ? 7 : 3.5) * throttle * dt;
      else d.speed *= Math.max(0, 1 - 1.4*dt);
      d.speed = Math.max(-maxR, Math.min(maxF, d.speed));
      if (!throttle && !brake && Math.abs(d.speed) < .02) d.speed = 0;
      const turn = steer * 1.5 * dt * Math.min(1, .35 + Math.abs(d.speed)/3) * (d.speed < 0 ? -1 : 1);
      const oang = d.ang; d.ang += turn;
      const nx0 = d.cx + Math.cos(d.ang)*d.speed*dt, nz0 = d.cz + Math.sin(d.ang)*d.speed*dt;
      let nx = d.cx, nz = d.cz;
      if (!carFootBlocked(nx0, nz, d.ang, d.L, d.Wd)) nx = nx0;
      if (!carFootBlocked(nx, nz0, d.ang, d.L, d.Wd)) nz = nz0;
      if (nx === d.cx && nz === d.cz && d.speed !== 0) d.speed = 0;
      d.cx = nx; d.cz = nz;
      d.grp.position.set(nx, 0, nz); d.grp.rotation.y = -d.ang; d.grp.updateMatrixWorld(true);
      if (d.col) { const ca = Math.cos(d.ang), sa = Math.sin(d.ang);
        const hw = (d.L*Math.abs(ca)+d.Wd*Math.abs(sa))/2, hd = (d.L*Math.abs(sa)+d.Wd*Math.abs(ca))/2;
        d.col[0] = nx-hw; d.col[1] = nz-hd; d.col[2] = nx+hw; d.col[3] = nz+hd; }
      camera.position.copy(d.grp.localToWorld(new THREE.Vector3(-d.L*.05, d.y0 + 1.0, -d.Wd*.22)));
      if (d.ang !== oang) camera.rotateY(-(d.ang - oang));        // 视角随车身转向，同时保留 PointerLock 的鼠标环视
      { const tf = FOV + Math.min(7, Math.abs(d.speed) * .9);     // 驾驶视野：车速越快 FOV 略拉宽（最高 +7°），提速更有冲刺感
        camera.fov += (tf - camera.fov) * Math.min(1, dt * 5);
        if (Math.abs(camera.fov - tf) < .05) camera.fov = tf;
        camera.updateProjectionMatrix(); }
    }
    function unstickWalk() {                                     // 脱离卡死：先在附近环形找同层空位挪过去（半径逐档放大），找不到回入户门；重置跳跃 / 跌落 / 攀梯 / 趴下状态
      if (anim || opt.mode !== 'walk') return;
      if (driveCar) { exitCar(); return; }                        // 驾驶中按 R = 下车（顺便把车写回方案）
      resetRunFx();
      const p = camera.position, foot = fallY === null ? 0 : fallY;
      let spot = null;
      for (const rad of [.5, .9, 1.4, 2.2, 3.2]) {
        for (let k = 0; k < 16 && !spot; k++) {
          const a = k * Math.PI / 8 + rad * .7;                  // 每圈错开起始角，避免同方向重复试探
          const x = p.x + Math.cos(a) * rad, z = p.z + Math.sin(a) * rad;
          const gy = stairH(x, z, foot);                         // 只认当前层附近的支撑高度，避免脱困时被拉上 / 拉下楼
          if (Math.abs(gy - foot) > .6 || blocked(x, z, .22, gy)) continue;
          spot = [x, z, gy];
        }
        if (spot) break;
      }
      proneOn = false; ladderOn = null; jumpV = jumpY = 0; fallV = 0;
      if (spot) {
        p.x = spot[0]; p.z = spot[1]; fallY = spot[2]; p.y = eyeH + spot[2];
        toast(tr('已脱离卡死', 'Unstuck'));
      } else {
        walkRespawn(); fallY = null;                             // 周围全是碰撞体：回入户门重开，支撑高度交给下一步重算
        toast(tr('附近没有空位，已回到入户门', 'No free spot nearby — back at the front door'));
      }
      stuckT = 0; if (stuckTip) stuckTip.classList.remove('open');
    }
    const _wf = new THREE.Vector3(), _wmv = new THREE.Vector3(), _wright = new THREE.Vector3();   // stepWalk 复用的临时向量（避免漫游每帧分配，同 blocked() 的 _v1 惯例）
    function stepWalk(dt) {
      if (!walkCtl.isLocked && !touchWalk) return;
      const p = camera.position, fwd = _wf;
      camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const grounded = jumpY <= 0 && jumpV <= 0;                 // 滞空时保持当前姿态，落回地面再生效
      const wantPosture = !grounded ? 0 : proneOn ? 2 : (keys.ControlLeft || keys.ControlRight || keys.KeyC) ? 1 : 0;   // 目标姿态：Z 切换的趴下（优先）＞ Ctrl/C 按住蹲下 ＞ 站立
      crouchT += (wantPosture - crouchT) * Math.min(1, dt * 9);  // 站起 / 蹲下 / 趴下平滑过渡
      postureHeights(crouchT);
      const ladHit = ladderAt(p.x, p.z, fallY === null ? 0 : fallY);   // 脚下位置是否贴近一架可攀爬的梯子（返回梯子对象）
      let climbing = false;
      if (ladHit && fallY !== null) {
        const wUp = keys.KeyW || keys.ArrowUp || (touchWalk && joy.y < -.25);
        const wDn = keys.KeyS || keys.ArrowDown || (touchWalk && joy.y > .25);
        const lh = Math.max(.8, (ladHit.h ?? 3000) / 1000);
        if ((wUp || wDn) && fallY <= lh) ladderOn = ladHit;            // 贴近 + 按上下 → 挂梯
        else if (ladderOn && ladderOn.id !== ladHit.id) ladderOn = null;
        if (ladderOn && ladderOn.id === ladHit.id) {                   // 攀爬中：W / S 沿梯上下（约 1.6 m/s），A / D 忽略，不坠不跳
          climbing = true;
          fallY = Math.max(0, Math.min(lh, fallY + ((wUp ? 1 : 0) - (wDn ? 1 : 0)) * 1.6 * dt));
          fallV = 0; jumpY = 0; jumpV = 0;
          if (fallY >= lh - .05) {                                     // 爬到顶：翻越到梯子背面（目标 = 梯身平面背后 0.35m，与挂梯位置无关；被挡则停在顶端）
            const a = ladHit.dir * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
            const tx = ladHit.x / 1000 - 6 - ca * ((ladHit.len ?? 600) / 2000 + .35);
            const tz = ladHit.y / 1000 - 5.3 - sa * ((ladHit.len ?? 600) / 2000 + .35);
            if (!blocked(tx, tz, .22, lh)) { p.x = tx; p.z = tz; fallY = lh; ladderOn = null; }
          }
          if (fallY <= 0) ladderOn = null;                             // 爬到底：脱离，恢复行走
        }
      } else ladderOn = null;
      if (keys.Space && crouchT < 1.2 && grounded && !climbing) jumpV = 3.1;   // 空格起跳（攀梯时禁跳；趴下时不能起跳，需先起身；按住落地自动连跳）
      if (jumpY > 0 || jumpV > 0) { jumpY += jumpV * dt; jumpV -= 9.5 * dt; if (jumpY <= 0) { jumpY = 0; jumpV = 0; } }
      const gy = stairH(p.x, p.z, p.y - eyeH - jumpY - bobY);       // 此处的支撑高度（地面 / 楼梯踏步 / 平台；剔除头部起伏，避免脚步视感干扰支撑面取样）
      if (fallY === null) fallY = gy;
      if (!climbing) {
        if (jumpY > 0 || jumpV > 0) {                          // 跳跃滞空：支撑高度暂不追，落回时再衔接
        } else if (gy < fallY - .3 || fallV !== 0) {           // 支撑面高差超过一步（走出平台边 / 台阶边）：进入跌落，重力下坠；楼梯踏步高 ≤ .2m 仍贴地顺走
          fallV -= 9.5 * dt; fallY += fallV * dt;
          if (fallY <= gy) { fallY = gy; fallV = 0; }          // 落到支撑面：跌落结束
        } else fallY = gy;                                     // 贴地行走 / 上台阶
      }
      const footH = fallY + jumpY;
      p.y = eyeH + footH + bobY;                             // 视点 = 视高 + 支撑 + 跑动头部起伏
      escCarry(p, footH, dt);                                // 站在自动扶梯上被梯级带着上行（先于输入移动，行走速度可叠加）
      if (climbing) {                                        // 攀梯中：A / D 与前后移动全部忽略（W / S 已由攀爬接管），只沿梯上下；跑动视感快速收平
        bobY *= Math.max(0, 1 - dt * 8); runAmt *= Math.max(0, 1 - dt * 5); syncRunFov(dt); return;
      }
      const shift = keys.ShiftLeft || keys.ShiftRight;
      const wantRun = (shift || (touchWalk && Math.hypot(joy.x, joy.y) > .92)) && crouchT < .5;   // 跑动意图：站立时按住 Shift；触屏摇杆推到底也算跑
      const sp = (crouchT >= 1.5 ? (shift ? .8 : .35) : crouchT > .5 ? .7 : wantRun ? 4.2 : 1.4) * dt, mv = _wmv.set(0, 0, 0);   // 趴下最慢（Shift 爬行加速）、蹲下次之、站立 Shift 全速跑；复用向量须先清零
      const right = _wright.set(-fwd.z, 0, fwd.x);
      if (keys.KeyW || keys.ArrowUp) mv.add(fwd); if (keys.KeyS || keys.ArrowDown) mv.sub(fwd);
      if (keys.KeyD || keys.ArrowRight) mv.add(right); if (keys.KeyA || keys.ArrowLeft) mv.sub(right);
      if (touchWalk) { mv.addScaledVector(fwd, -joy.y).addScaledVector(right, joy.x); }
      const mag = Math.min(1, mv.length());        // 摇杆推得越远走得越快
      runAmt += ((wantRun && mag > .5 ? 1 : 0) - runAmt) * Math.min(1, dt * 5);   // 跑动强度插值：控制 FOV 扩张与头部起伏幅度
      if (mag < .05) {                                       // 静止：起伏快速归零，FOV 平滑回到走路视野
        stuckT = 0; bobT += dt * (2.2 + runAmt * 3.4); bobY *= Math.max(0, 1 - dt * 8); syncRunFov(dt);
        if (stuckTip) stuckTip.classList.remove('open'); return;
      }
      mv.normalize().multiplyScalar(sp * mag);
      const px0 = p.x, pz0 = p.z;
      if (!blocked(p.x + mv.x, p.z, .22, footH)) p.x += mv.x;
      if (!blocked(p.x, p.z + mv.z, .22, footH)) p.z += mv.z;
      const moved = Math.hypot(p.x - px0, p.z - pz0);        // 实际位移（贴墙滑行会小于预期）：起伏相位跟随真实步伐
      bobT += moved * (3.4 + runAmt * 2.4);                  // 步频：走约 3.4 rad/m，跑更密（脚步更快）
      bobY = grounded ? Math.sin(bobT) * (.022 + runAmt * .033) * Math.min(1, moved / (sp * mag + 1e-6)) : bobY * Math.max(0, 1 - dt * 6);   // 落地才起伏：走 ±2.2cm、跑 ±5.5cm；跳跃滞空收平
      syncRunFov(dt);
      stuckT = moved < sp * mag * .2 ? stuckT + dt : 0;   // 有输入但两轴都被挡、位移不到预期的两成：累计卡死时长；贴墙滑行（能挪动）不算
      if (stuckTip) {
        if (stuckT > 1.5) {                                        // 卡死超过 1.5 秒：准星下方提示脱离（桌面按 R，触屏点提示条）
          stuckTip.textContent = touchWalk ? tr('卡住了？点此脱离', 'Stuck? Tap to break free') : tr('卡住了？按 R 脱离', 'Stuck? Press R to break free');
          stuckTip.classList.add('open');
        } else stuckTip.classList.remove('open');
      }
    }
    function escCarry(p, foot, dt) {                           // 自动扶梯传送：脚落在梯面上（高度吻合且非滞空）时，沿行进方向以梯级同速（.35 m/s，与主循环梯级动画一致）被带动；两端 150mm 内不传送（视作落在端部地板）；带 blocked 碰撞，不会被推穿墙。单跑 / 双跑按各自跑判定
      for (const s of (state.stairs || [])) {
        if (s.type !== 'esc') continue;
        const lay = stairLayout(s);
        const a = s.dir * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        const dx = p.x * 1000 + 6000 - s.x, dy = p.z * 1000 + 5300 - s.y;   // 世界米 → 平面毫米（与 stairH 同一套坐标换算：x 基准 6000、z 基准 5300）
        const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
        for (const r of lay.runs) {
          if (Math.abs(ly - r.z) > s.w / 2) continue;
          const xa = Math.min(r.x0, r.x1), xb = Math.max(r.x0, r.x1);
          if (lx < xa + 150 || lx > xb - 150) continue;      // 两端 150mm 内不传送（视作落在端部地板上，避免站在回转区被带下楼板）
          const t = r.dir > 0 ? (lx - r.x0) / (r.x1 - r.x0) : (r.x0 - lx) / (r.x0 - r.x1);   // 沿跑的爬升比例（与 stairH 插值一致）
          if (Math.abs(foot - (r.y0 + Math.max(0, Math.min(1, t)) * (r.y1 - r.y0)) / 1000) > .25) continue;   // 脚不在该跑梯面上（空中 / 梯下 / 另一跑 / 隔层）不传送
          const ux = ca * r.dir, uz = sa * r.dir, step = .35 * dt;
          if (!blocked(p.x + ux * step, p.z, .22, foot)) p.x += ux * step;
          if (!blocked(p.x, p.z + uz * step, .22, foot)) p.z += uz * step;
          return;
        }
      }
    }
    function ladderAt(x, z, foot) {                            // 判定脚下位置是否贴近一架可攀爬的梯子：横向在梯宽内、正面 0.42m 内、脚不高于梯顶；返回该梯子对象或 null
      for (const s of (state.stairs || [])) {
        if (s.type !== 'ladder') continue;
        const a = s.dir * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        const dx = x * 1000 + 6000 - s.x, dy = z * 1000 + 5300 - s.y;
        const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
        const h = Math.max(.8, (s.h ?? 3000) / 1000), d = s.len ?? 600;
        if (Math.abs(ly) > s.w / 2 + 120) continue;
        if (lx < -150 || lx > d / 2 + 300) continue;           // 正面 0.3m 内可挂梯（背面是跨上方向，不挂）
        if (foot > h + .05) continue;                          // 已在梯顶上方（上层）不挂梯
        return s;
      }
      return null;
    }
    function pushOutOfRevolve(p, foot, head, pushR = .23) {    // 旋转门翼转到身上时，把对象推离翼（真实旋转门是翼推着人走，避免玻璃翼穿过玩家）；漫游玩家与家禽共用
      for (const w of revolveHit) {
        if (foot + head < w.y0 || foot > w.y1) continue;         // 高度不匹配（隔层）
        const dx = p.x - w.mx, dz = p.z - w.mz;
        if (dx * dx + dz * dz > (w.r + .3) ** 2) continue;       // 不在转盘内
        for (let k = 0; k < 3; k++) {
          const a = w.spin.rotation.y + k * Math.PI * 2 / 3, ux = Math.cos(a), uz = -Math.sin(a);
          let t = (dx * ux + dz * uz) / w.r; t = Math.max(0, Math.min(1, t));   // 玩家在翼线段上的最近点参数
          const qx = w.mx + ux * w.r * t, qz = w.mz + uz * w.r * t;
          let nx = p.x - qx, nz = p.z - qz, d = Math.hypot(nx, nz);
          if (d < pushR) {
            if (d < 1e-5) { nx = -uz; nz = ux; d = 1; }         // 恰好压在翼上：沿切向推开，避免除零
            p.x = qx + nx / d * pushR; p.z = qz + nz / d * pushR;
          }
        }
      }
    }

    /* ======================= 射击彩蛋 ======================= */
    // 漫游模式点击射击：软弹珠打在墙面/家具上留下小凹痕（渐隐），带弹道与音效，纯视觉效果不改方案
    const fxList = [];
    let audioCtx = null;
    function shootFx(obj, life) {          // 加入特效队列，life 秒后渐隐移除（最多同时 26 个）
      fxList.push({ o: obj, t0: life, life }); scene.add(obj);
      if (fxList.length > 26) { const x = fxList.shift(); scene.remove(x.o); x.o.geometry?.dispose(); x.o.material?.dispose(); }
    }
    function shootSound() {                // WebAudio 合成短促「啪」声，无需音频文件
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const t = audioCtx.currentTime, n = audioCtx.createBufferSource();
        const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * .12 | 0, audioCtx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.6);
        n.buffer = buf;
        const f = audioCtx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 950;
        const g = audioCtx.createGain(); g.gain.setValueAtTime(.45, t); g.gain.exponentialRampToValueAtTime(.001, t + .12);
        n.connect(f).connect(g).connect(audioCtx.destination); n.start(t);
      } catch (err) { console.warn('音效播放不可用（浏览器禁用 AudioContext？）', err); }
    }
    function shoot(e) {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(e ? (e.clientX - r.left) / r.width * 2 - 1 : 0, e ? -((e.clientY - r.top) / r.height) * 2 + 1 : 0);
      ray.setFromCamera(ptr, camera);
      let hit = null;                                            // 漫游辅助线 / 玻璃 / 高亮层不挡子弹
      for (const h of ray.intersectObjects([archUp, archFloor, furnG], true)) {
        if (h.object.material === glassMat || h.object === doorHiRef || h.object.userData.walkOnly || h.object.isLine || h.object.isLineSegments) continue;
        hit = h; break;
      }
      const from = camera.position.clone().add(new THREE.Vector3(.12, -.09, 0).applyQuaternion(camera.quaternion));   // 枪口在视点右下
      const to = hit ? hit.point.clone() : ray.ray.at(9, new THREE.Vector3());
      const dir = to.clone().sub(from), len = Math.max(.05, dir.length());
      const tracer = new THREE.Mesh(new THREE.CylinderGeometry(.004, .004, len, 5), new THREE.MeshBasicMaterial({ color: '#ffd27f', transparent: true, opacity: .85 }));
      tracer.position.copy(from).addScaledVector(dir, .5); tracer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      shootFx(tracer, .09);
      if (hit && hit.face) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const hole = new THREE.Mesh(new THREE.CircleGeometry(.022, 12), new THREE.MeshBasicMaterial({ color: '#3a332b', transparent: true, opacity: .8 }));
        hole.position.copy(hit.point).addScaledVector(n, .012); hole.lookAt(hit.point.clone().add(n));
        shootFx(hole, 1.6);
        const puff = new THREE.Mesh(new THREE.SphereGeometry(.03, 8, 6), new THREE.MeshBasicMaterial({ color: '#e8dcc8', transparent: true, opacity: .7 }));
        puff.position.copy(hit.point).addScaledVector(n, .045);
        shootFx(puff, .22);
      }
      shootSound();
    }
    function stepFx(dt) {                  // 特效渐隐
      for (let i = fxList.length - 1; i >= 0; i--) {
        const f = fxList[i]; f.life -= dt;
        if (f.life <= 0) { scene.remove(f.o); f.o.geometry?.dispose(); f.o.material?.dispose(); fxList.splice(i, 1); }
        else if (f.o.material) f.o.material.opacity = Math.min(.85, .85 * f.life / f.t0 * 1.4);
      }
    }
    /* 安防监控实时画面：
       1) 每台显示器按「录像机 mons 含该显示器 → 并入该录像机 cams」得到要显示的摄像机；
       2) 从每台在用摄像机的离屏相机视角真实渲染场景到 WebGLRenderTarget，读回像素翻正到 canvas；
       3) 把各路画面按 1/2/4/9 分屏合成到显示器 canvas，叠加通道名 / 时间 / REC / 扫描线 / 暗角；无画面显示雪花「无信号」。
       节流 ~8fps：多路离屏渲染 + 读回较费，避免拖慢主场景；渲染前隐藏所有屏幕避免摄像机拍到屏幕形成反馈。 */
    function survFeeds(monId) {
      const out = [], seen = new Set();
      (state.extras || []).forEach(n => {
        if (!isNVR(n.type) || !(n.mons || []).includes(monId)) return;
        (n.cams || []).forEach(cid => {
          if (seen.has(cid)) return;
          const rig = survRigs.find(r => r.id === cid);
          if (rig) { seen.add(cid); out.push(rig); }
        });
      });
      return out;
    }
    function stepSurveillance(now) {
      if (!survScreens.length || !survRigs.length) return;
      if (now - survT.last < 120) return;
      survT.last = now;
      const d = new Date(), pad = n => String(n).padStart(2, '0');
      const stamp = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const perMon = survScreens.map(s => ({ s, feeds: survFeeds(s.id) }));
      const need = new Set(); perMon.forEach(p => p.feeds.forEach(r => need.add(r)));
      const prevTarget = renderer.getRenderTarget();
      if (need.size) {
        survScreenMeshes.forEach(m => m.visible = false);               // 取景时隐藏所有屏幕，避免画面反馈 / 深度串扰
        need.forEach(r => {
          renderer.setRenderTarget(r.rt);
          renderer.render(scene, r.cam);
          renderer.readRenderTargetPixels(r.rt, 0, 0, r.src.width, r.src.height, r.buf);
          const data = r.img.data, W = r.src.width, H = r.src.height;
          for (let y = 0; y < H; y++) {                                 // 读回自下而上 → 翻正到 ImageData
            const from = (H - 1 - y) * W * 4, to = y * W * 4;
            for (let x = 0; x < W * 4; x++) data[to + x] = r.buf[from + x];
            for (let x = 0; x < W; x++) data[to + x * 4 + 3] = 255;      // 强制不透明
          }
          r.sctx.putImageData(r.img, 0, 0);
        });
        renderer.setRenderTarget(prevTarget);
        survScreenMeshes.forEach(m => m.visible = true);
      }
      perMon.forEach(({ s, feeds }) => {
        const g = s.ctx, W = s.cv.width, H = s.cv.height;
        g.fillStyle = '#0a1018'; g.fillRect(0, 0, W, H);
        if (!feeds.length) {                                           // 无信号：雪花 + 提示
          const im = g.createImageData(W, H);
          for (let i = 0; i < im.data.length; i += 4) {
            const v = Math.random() * 92; im.data[i] = v; im.data[i + 1] = v + 8; im.data[i + 2] = v + 16; im.data[i + 3] = 255;
          }
          g.putImageData(im, 0, 0);
          g.fillStyle = 'rgba(8,14,22,.55)'; g.fillRect(0, 0, W, H);
          g.fillStyle = '#cfe0ea'; g.font = 'bold 48px ui-monospace, Menlo, Consolas, monospace';
          g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('NO SIGNAL', W / 2, H / 2 - 14);
          g.font = '24px system-ui, sans-serif'; g.fillStyle = '#93a9b8'; g.fillText(tr('无信号 · 未连接录像机或摄像机', 'No signal · no NVR / camera connected'), W / 2, H / 2 + 36);
        } else {
          const n = feeds.length, cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
          const rows = Math.ceil(Math.min(n, 16) / cols), cw = W / cols, ch = H / rows;
          feeds.slice(0, 16).forEach((r, k) => {
            const x = (k % cols) * cw, y = Math.floor(k / cols) * ch;
            g.drawImage(r.src, x, y, cw, ch);                          // 真实取景画面
            g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x, y, cw, 26); g.fillRect(x, y + ch - 22, cw, 22);
            g.fillStyle = '#eaf6ff'; g.font = 'bold 15px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'left';
            g.fillText(`CH${String(k + 1).padStart(2, '0')} ${r.name}`, x + 7, y + 18);
            g.fillStyle = '#bcd0dc'; g.font = '13px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'right';
            g.fillText(`${date} ${stamp}`, x + cw - 7, y + ch - 7);
            if (Math.floor(now / 700) % 2 === 0) { g.fillStyle = '#ff4b4b'; g.beginPath(); g.arc(x + cw - 14, y + 13, 5, 0, Math.PI * 2); g.fill(); }
            g.strokeStyle = 'rgba(150,190,215,.45)'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, cw - 1, ch - 1);
          });
          for (let k = feeds.length; k < cols * rows; k++) {           // 空分屏位：深色底 +「无视频输入」，不再是突兀的黑块
            const x = (k % cols) * cw, y = Math.floor(k / cols) * ch;
            g.fillStyle = '#10161d'; g.fillRect(x, y, cw, ch);
            g.fillStyle = '#5f7383'; g.font = '18px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(tr('无视频输入', 'NO VIDEO'), x + cw / 2, y + ch / 2);
            g.strokeStyle = 'rgba(150,190,215,.2)'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, cw - 1, ch - 1);
          }
          g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        }
        g.fillStyle = 'rgba(0,0,0,.07)';                               // 扫描线
        for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
        const vg = g.createRadialGradient(W / 2, H / 2, W * .3, W / 2, H / 2, W * .72);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.35)');
        g.fillStyle = vg; g.fillRect(0, 0, W, H);                       // 暗角
        s.tex.needsUpdate = true;
      });
    }
    document.addEventListener('pointerdown', e => {              // 桌面漫游（鼠标锁定时点击 = 射击）
      if (active && opt.mode === 'walk' && walkCtl.isLocked && e.button === 0) shoot();
    });

    addEventListener('keydown', e => {
      if (!active || e.target.matches('input,select,textarea')) return;
      if (opt.mode === 'walk' && e.code === 'Space') e.preventDefault();   // 空格用于跳跃，阻止页面滚动
      if (opt.mode === 'walk' && e.code === 'KeyZ') proneOn = !proneOn;    // Z 切换趴下 / 起身
      if (opt.mode === 'walk' && e.code === 'KeyR') unstickWalk();         // R 脱离卡死：附近找空位，找不到回入户门
      if (opt.mode === 'walk' && (e.ctrlKey || e.metaKey) && /^(Key[WASD]|Arrow)/.test(e.code)) e.preventDefault();   // 漫游下蹲时按 WASD 移动：尽力阻止触发浏览器快捷键
      keys[e.code] = true;
      if (opt.mode === 'walk' && e.code === 'KeyE') { if (driveCar) { exitCar(); return; } const h = pick(); if (h?.liftBtn && h.dist < 2.5) liftBtnAct(h.liftBtn); else if (h?.door && h.dist < 2.5) toggleDoor(h.door); else if (h?.carWin && h.dist < 2.5) toggleDoor(h.carWin); else if (h?.carLamp && h.dist < 2.5) toggleCarLamp(h.carLamp); else if (h?.gateArm && h.dist < 3.5) toggleGateArm(h.gateArm); else if (h?.park && h.dist < 3.5) togglePark(h.park); else if ((h?.flagSel || h?.flagHandle) && h.dist < 2.5) startFlagAnim((state.extras || []).find(x => x.id === (h.flagSel || h.flagHandle))); else if (h?.kind === 'lamp' && h.dist < 2.5) toggleLamp(h.id, h.gang); else if ((h?.kind === 'streetlamp' || h?.kind === 'solarlamp') && h.dist < 3.5) toggleStreetLamp(h.id, false); else if (h?.kind === 'traflight' && h.dist < 3.5) cycleTrafficLight(h.id); else if (h?.kind === 'facLaneLight' && h.dist < 3.5) cycleLaneLight(h.id); else if (carIdFromHit(h) != null && h.dist < 3.5) enterCar(carIdFromHit(h)); }   // 车门 / 车灯 / 其它设施动作优先，车身本身按 E = 上车
    });
    addEventListener('keydown', e => {                            // F：驾驶时下车；漫游瞄准轿车时上车（与 E 车身同源，独立按键避免与车门 / 车灯动作冲突）
      if (opt.mode !== 'walk') return;
      if (driveCar) { if (e.code === 'KeyF') { exitCar(); e.preventDefault(); } return; }
      if (e.code === 'KeyF') { const h = pick(); const cid = carIdFromHit(h); if (cid != null && h.dist < 3.5) { enterCar(cid); e.preventDefault(); } }
    });
    addEventListener('keyup', e => keys[e.code] = false);

    /* ======================= 工具栏 ======================= */
    function syncModeBtns() { document.querySelectorAll('#modes3d .btn').forEach(b => b.classList.toggle('on', b.dataset.mode === opt.mode)); }
    function syncCutBtns() {
      document.querySelectorAll('[data-cut]').forEach(b => {
        const v = +b.dataset.cut, isFull = v >= FULL_CUT - 1e-6;
        b.classList.toggle('on', isFull ? !!opt.full : !opt.full && Math.abs(opt.cut - v) < 1e-6);
      });
    }
    function syncWalkTexts() {
      const t = COARSE
        ? [tr('点击开始，从入户门进入', 'Tap to start at the front door'), tr('左下摇杆移动 · 在画面上拖动转向', 'Joystick moves · drag on screen to look'),
        tr('点门开关 · 点「退出漫游」回到鸟瞰', 'Tap doors to open · "Exit walk" returns to orbit')]
        : [tr('点击开始，从入户门进入', 'Click to start at the front door'),
        tr('<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> 移动 · 鼠标转向 · <kbd>Shift</kbd> 快走 · <kbd>Ctrl</kbd> 蹲下', '<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> move · mouse looks · <kbd>Shift</kbd> runs · <kbd>Ctrl</kbd> crouch'),
        tr('<kbd>C</kbd> 也可蹲下 · <kbd>Z</kbd> 切换趴下 · <kbd>E</kbd> 交互 · <kbd>空格</kbd> 跳跃 · <kbd>R</kbd> 脱离卡死 · <kbd>Esc</kbd> 暂停', '<kbd>C</kbd> also crouches · <kbd>Z</kbd> toggles prone · <kbd>E</kbd> interact · <kbd>Space</kbd> jumps · <kbd>R</kbd> unstuck · <kbd>Esc</kbd> pauses')];
      t.forEach((h, i) => $('#wo' + (i + 1)).innerHTML = h);
      syncHint3d();
    }
    function bindUI() {
      document.querySelectorAll('#modes3d .btn').forEach(b => b.onclick = () => setMode(b.dataset.mode));
      // 触屏设备用摇杆漫游；桌面端锁定鼠标，锁定失败时也退回到摇杆
      $('#walkOverlay').onclick = () => COARSE ? startTouchWalk() : walkCtl.lock();
      document.addEventListener('pointerlockerror', () => { if (active && opt.mode === 'walk') startTouchWalk(); });
      $('#walkExit').onclick = () => setMode('orbit');
      bindJoystick();
      syncWalkTexts();
      $('#vIso').onclick = () => { if (opt.mode === 'walk') setMode('orbit'); else flyTo(opt.allFloors ? allFloorsPose() : isoWhole()); };
      $('#vTop').onclick = () => { if (opt.mode === 'walk') setMode('orbit'); flyTo(topWhole()); };
      document.querySelectorAll('[data-cut]').forEach(b => b.onclick = () => {
        if (opt.mode === 'walk') return;
        const v = +b.dataset.cut;
        opt.full = v >= FULL_CUT - 1e-6;                            // 「全高墙」= 跟随当前楼层高度，不是写死 2.8m
        opt.cut = opt.full ? H : v;
        syncCutBtns(); sync();
      });
      document.querySelectorAll('#toggles3d .btn, #sunPad .btn').forEach(b => b.onclick = () => {
        const k = b.dataset.t; opt[k] = !opt[k]; b.classList.toggle('on', opt[k]);
        if (k === 'furn') { furnG.visible = opt.furn; if (!opt.furn && ui.sel?.kind === 'furn') window.select(null); }
        if (k === 'labels') showLabels(opt.labels && opt.mode === 'orbit' && !anim);
        if (k === 'slabs') { setSlabVis(opt.slabs); typeof scheduleAutoSave === 'function' && scheduleAutoSave(); }   // 楼板开关：同步回图层设置持久化
        if (k === 'hi') window.clearDoorHi?.();                 // 交互高亮切换：清掉残留的悬停高亮框（提示气泡保留，随下次悬停刷新）
        if (k === 'night') {
          const n = opt.night ? autoLightStreetlamps() : 0;       // 进入夜景自动开灯；离开夜景不改开关状态
          applyLight();
          if (n) toast(tr(`夜景已自动开启 ${n} 盏路灯（可手动关闭）`, `Night mode turned on ${n} street lamp${n > 1 ? 's' : ''} (can be switched off manually)`));
        }
      });
      $('#sun').oninput = e => { opt.hour = +e.target.value; applyLight(); };
    }

    /* ======================= 主循环 ======================= */
    const clock = new THREE.Clock();
    function startLoop() { if (!raf) { clock.getDelta(); raf = requestAnimationFrame(loop); } }
    // 漫游门交互提醒：准星瞄准门（<2.5m）→ 门扇高亮 + 准星下方提示按键 / 点击
    const walkTip = document.createElement('div'); walkTip.id = 'walkDoorTip'; document.body.appendChild(walkTip);
    stuckTip = document.createElement('div'); stuckTip.id = 'walkStuckTip'; document.body.appendChild(stuckTip);
    stuckTip.onclick = () => unstickWalk();                     // 触屏无 R 键：直接点提示条脱离卡死
    const driveExit = document.createElement('button'); driveExit.id = 'driveExitBtn'; driveExit.textContent = tr('下车', 'Exit car'); document.body.appendChild(driveExit);
    driveExit.onclick = () => exitCar();                        // 驾驶中触屏下车（与键盘 E / F 同源）
    const applyCarVisual = id => {                                // 轿车门盖 / 天窗：state → 运行时 doors[]，2D / 3D 同步
      const e = (state.extras || []).find(x => String(x.id) === String(id)); if (!e) return;
      doors.forEach(d => { if ((d.kind === 'car' || d.kind === 'carWin') && String(d.carId) === String(id)) d.open = !!e[d.field]; });
      renderExtras2();
    };
    window.applyCarVisual = applyCarVisual;
    const toggleCarDoor = (carId, part) => {                       // 轿车门盖开合：写回 state + 撤销历史 + 同步面板 / 2D
      const e = (state.extras || []).find(x => String(x.id) === String(carId)); if (!e) return;
      mutateLive3D(() => { e[part] = !e[part]; }); applyCarVisual(carId);
      const d = doors.find(x => x.kind === 'car' && String(x.carId) === String(carId) && x.part === part);
      const lb = d?.label || ['车门','car panel'];
      toast(tr(`${lb[0]}已${e[part] ? '打开' : '关闭'}`, `${lb[1]} ${e[part] ? 'opened' : 'closed'}`));
    };
    const toggleCarWindow = (carId, part) => {                     // 轿车侧窗升降：写回 state + 撤销历史 + 同步面板 / 2D
      const e = (state.extras || []).find(x => String(x.id) === String(carId)); if (!e) return;
      mutateLive3D(() => { e[part] = !e[part]; }); applyCarVisual(carId);
      const d = doors.find(x => x.kind === 'carWin' && String(x.carId) === String(carId) && x.part === part);
      const lb = d?.label || ['车窗','car window'];
      toast(tr(`${lb[0]}已${e[part] ? '降下' : '升起'}`, `${lb[1]} ${e[part] ? 'lowered' : 'raised'}`));
    };
    const toggleCarLamp = carId => {                              // 轿车车灯开关：写回 state + 撤销历史 + 3D / 2D 同步重建
      const e = (state.extras || []).find(x => String(x.id) === String(carId)); if (!e) return;
      mutate(() => { e.lights = e.lights === false; });
      toast(tr(`车灯已${e.lights ? '打开' : '关闭'}`, `Headlights ${e.lights ? 'on' : 'off'}`));
    };
    const toggleDoor = d => {                                     // 普通门手动开合入口：电梯门（带 liftId）只由呼叫面板控制，这里一律忽略
      if (d.kind === 'car') { toggleCarDoor(d.carId, d.part); return; }   // 轿车四门 / 机盖 / 尾门：写回 state，进撤销栈
      if (d.kind === 'carWin') { toggleCarWindow(d.carId, d.part); return; }   // 轿车侧窗升降按钮：写回 state，进撤销栈
      if (d.lift && d.liftId != null) return;
      d.open = !d.open;
      if (d.peer && d.open) d.peer.open = false;                  // 推拉窗：推开一边时对扇自动退回（同一洞口只有一边打开）
      if (d.lift) d.tAuto = d.open ? performance.now() + 6000 : 0;   // 电梯门自动关仍由 tAuto 驱动，手动入口已被面板取代
    };
    const liftDoorOf = (id, source) => doors.find(d => d.lift && d.liftId === id && (!source || d.liftSource === source));   // 按电梯 id / 来源找门（car=轿厢门，hall=建筑工具层门）
    const liftDoorsOf = id => doors.filter(d => d.lift && d.liftId === id);   // 同一部电梯的轿厢门 + 所有联动层门
    const liftHallDoors = id => doors.filter(d => d.lift && d.liftId === id && d.liftSource === 'hall');
    const doorWorldY0 = d => (d.y0 ?? -9) + (d.yOff || 0);        // 其它楼层门存的是本层局部 y0，联动判定统一换算到「相对当前层」的世界高度
    const liftDoorsHere = (id, base, k = null) => doors.filter(d => d.lift && d.liftId === id && (d.liftSource === 'car' || (k != null && d.liftFloor === k) || Math.abs(doorWorldY0(d) - base) < .3));   // 轿厢门 + 该层联动层门：优先按楼层索引（手设停靠标高时对得上），再按世界标高兜底
    function openLiftDoors(id, base, doorId, k = null) {           // 到站开门：轿厢门必开；层站呼叫开被点的那扇（按 id 重新取，避免用重建前的旧指针），轿厢内选层开目标层的全部层门
      const open = d => { if (d) { d.open = true; d.tAuto = performance.now() + 6000; } };
      open(liftDoorOf(id, 'car'));
      const halls = liftHallDoors(id);
      const specific = doorId ? halls.find(d => d.oid === doorId) : null;
      if (specific) { open(specific); return; }
      const kk = k ?? liftCurIdx(id);                             // 调用方没带楼层索引时按电梯当前层反推（到站时 l.cur 已更新）
      const byFloor = halls.filter(d => d.liftFloor === kk);      // 整栋模式 2F 门洞的 y0 是 2F 局部 0，不能拿它和 1F 基准的 4.2m 停靠高度比；按门洞所在楼层索引匹配才可靠
      if (byFloor.length) { byFloor.forEach(open); return; }
      halls.filter(d => Math.abs(doorWorldY0(d) - base) < .3).forEach(open);   // 兜底：老数据没有楼层索引时按世界标高匹配
    }
    const liftBaseOf = l => liftRides.has(l.id) ? liftRides.get(l.id).base : Math.max(0, (l.stop ?? 0) / 1000 - floorY());
    const liftFloors = l => Array.isArray(l?.floors) && l.floors.length ? l.floors : [l?.stop ?? 0];
    const liftFloorY = (l, k) => {                               // 电梯各层停靠高度换算到「当前楼层 y=0」的相对坐标
      const fs = liftFloors(l), i = Math.max(0, Math.min(fs.length - 1, Math.round(+k || 0)));
      return Math.max(0, (fs[i] ?? 0) / 1000 - floorY());
    };
    const liftQueueOf = id => { let q = liftLit.get(id); if (!q) liftLit.set(id, q = new Set()); return q; };
    function liftCurIdx(id) {                                     // 显示屏上的当前楼层：运行中取最近层，静态取方案当前层
      const l = (state.lifts || []).find(x => x.id === id); if (!l) return 0;
      const fs = liftFloors(l), r = liftRides.get(id);
      if (r) {
        let k = 0, bd = Infinity;
        fs.forEach((v, i) => { const d = Math.abs(liftFloorY(l, i) - r.base); if (d < bd) { bd = d; k = i; } });
        return k;
      }
      return Math.max(0, Math.min(fs.length - 1, Math.round(l.cur ?? 0)));
    }
    function liftRefreshDisp(id) {                                // 重绘该电梯的显示屏与所有联动面板（当前层 + 整栋其它楼层 + 亮灯的目标层）
      const a = liftAllDisp(id); if (!a.length) return;
      const cur = liftCurIdx(id), lit = liftLit.get(id);
      a.forEach(p => p.setState(cur, lit));
    }
    function liftNextStop(id, from) {                             // 顺向优先取下一站：同向最近；同向无目标则反向最近并换向
      const lit = liftLit.get(id); if (!lit || !lit.size) return null;
      const l = (state.lifts || []).find(x => x.id === id); if (!l) return null;
      const fs = liftFloors(l), dir = liftDir.get(id) || 0;
      let best = null, bd = Infinity;
      for (const k of lit) {
        const y = liftFloorY(l, k);
        if (dir > 0 && y < from - .005) continue;
        if (dir < 0 && y > from + .005) continue;
        const d = Math.abs(y - from);
        if (d < bd) { bd = d; best = k; }
      }
      if (best == null) for (const k of lit) {                    // 同向已无目标：反向取最近的一层
        const y = liftFloorY(l, k), d = Math.abs(y - from);
        if (d < bd) { bd = d; best = k; }
      }
      if (best != null) {
        const y = liftFloorY(l, best);
        if (Math.abs(y - from) > .005) liftDir.set(id, y > from ? 1 : -1);
      }
      return best;
    }
    function liftTryInsert(id, k) {                               // 运行途中新登记的楼层在前方且更近：改去该层（真实电梯顺路先停）
      const r = liftRides.get(id); if (!r) return false;
      const l = (state.lifts || []).find(x => x.id === id); if (!l) return false;
      const fs = liftFloors(l), y = liftFloorY(l, k);
      const p0 = r.p0 ?? r.from, dir = r.to > p0 + .005 ? 1 : r.to < p0 - .005 ? -1 : 0;
      if (!dir) return false;
      if ((y - r.base) * dir <= .08) return false;                // 不在前进方向，或已经过了这一层
      if ((y - r.to) * dir >= -.005) return false;                // 不比当前目标更近：按原计划继续
      const now = performance.now();
      r.p0 = r.base; r.to = y; r.floor = k; r.move0 = now + 120;  // 从当前高度重新起步，位置不跳变
      r.t0 = now; r.dur = Math.max(500, Math.abs(y - r.base) / 1.6 * 1000);
      liftDir.set(id, dir);
      liftRefreshDisp(id);
      return true;
    }
    function liftStart(l, k, doorId = null) {                     // 关门 → 出发前往第 k 层；到站由 liftRideStep 开门、消灯、续行
      const fs = liftFloors(l), from = liftBaseOf(l), to = liftFloorY(l, k);
      const now = performance.now();
      liftDoorsOf(l.id).forEach(d => { d.open = false; d.tAuto = 0; });
      liftGo.delete(l.id);
      liftDir.set(l.id, to > from + .005 ? 1 : to < from - .005 ? -1 : (liftDir.get(l.id) || 0));
      liftRides.set(l.id, { id: l.id, floor: k, from, p0: from, to, base: from, t0: now, move0: now + 420, dur: Math.max(900, Math.abs(to - from) / 1.6 * 1000), carry: liftInCar(l, from), doorId });
      liftRefreshDisp(l.id);
      const fl = liftFloorLabel(l, k);
      toast(tr(`电梯正在前往 ${fl} 层`, `Lift is going to ${fl}`));
    }
    function liftQueueStep(now) {                                 // 到站开门后：等门关到位再继续下一个已登记楼层（光幕挡门期间保持等待）
      if (!liftGo.size) return;
      for (const [id, q] of [...liftGo]) {
        if (now < q.tAt) continue;
        if (liftRides.has(id)) { liftGo.delete(id); continue; }
        const l = (state.lifts || []).find(x => x.id === id);
        if (!l) { liftGo.delete(id); liftLit.delete(id); liftDoorReq.delete(id); liftDir.delete(id); continue; }
        const from = liftBaseOf(l), fs = liftFloors(l), lit = liftLit.get(id);
        if (liftDoorsHere(id, from, liftCurIdx(id)).some(d => d.open || d.cur > .06)) continue;   // 轿厢门 / 本层层门还开着或正在关：等两扇门都关到位（光幕挡门顺延期间不出发）
        liftGo.delete(id);
        if (lit) for (const k of [...lit]) if (Math.abs(liftFloorY(l, k) - from) < .01) lit.delete(k);   // 已在脚下的目标层直接消灯
        const next = liftNextStop(id, from);
        if (next == null) { liftDir.delete(id); liftRefreshDisp(id); continue; }   // 队列跑空：本次运行结束
        const dq = liftDoorReq.get(id);
        liftStart(l, next, dq ? (dq.get(next) ?? null) : null);
      }
    }
    function liftInCar(l, base) {                                 // 玩家是否站在轿厢内（含门口 120mm 余量，与 stairH 支撑范围一致）
      if (opt.mode !== 'walk') return false;
      const th = -(l.dir || 0) * Math.PI / 180, ct = Math.cos(th), st = Math.sin(th);
      const dx = camera.position.x * 1000 + 6000 - l.x, dz = camera.position.z * 1000 + 5300 - l.y;
      const lx = dx * ct - dz * st, ly = dx * st + dz * ct;
      const hw = Math.max(800, l.w ?? 2000) / 2 + 120, hd = Math.max(800, l.d ?? 2000) / 2 + 120;
      return Math.abs(lx) <= hw && Math.abs(ly) <= hd && Math.abs((camera.position.y - eyeH) - base) <= .55;
    }
    function liftDoorBlocked(d, k = 1) {                          // 光幕防夹：门洞前后一条窄带内是否有人 / 动物（k 用于关门前略放宽）
      if (!d || d.gx == null || d.ex == null) return false;
      const sh = (d.half ?? .6) + .12 * k, sn = .34 * k;           // 沿门面半宽 / 垂直门面余量（真实光幕只在门平面附近）
      const off = d.yOff || 0;                                    // 其它楼层门的局部高度 → 世界高度：光幕按玩家世界脚高判定
      const y0 = (d.base ?? d.y0 ?? 0) + off - .05, y1 = (d.top ?? d.y1 ?? 9) + off + .25;
      const hit = (x, y, z) => {
        if (y < y0 || y > y1) return false;
        const px = x - d.gx, pz = z - d.gz;
        return Math.abs(px * d.ex + pz * d.ez) <= sh && Math.abs(px * d.nx + pz * d.nz) <= sn;
      };
      if (opt.mode === 'walk' && hit(camera.position.x, camera.position.y - eyeH, camera.position.z)) return true;   // 玩家：脚高落到门洞高度区间
      for (const g of furnG.children) if (g.userData.poultry && hit(g.position.x, g.position.y + .05, g.position.z)) return true;   // 动物与感应门一致
      return false;
    }
    const liftCarrying = () => [...liftRides.values()].some(r => r.carry && opt.mode === 'walk');
    function liftRideStep(now) {                                  // 逐帧驱动电梯：关门 → 平滑升降 → 到站重建并开门；玩家在轿厢内时随轿厢升降
      if (!liftRides.size) return;
      for (const [id, r] of [...liftRides]) {
        const l = (state.lifts || []).find(x => x.id === id);
        if (!l) { liftRides.delete(id); continue; }
        const ds = liftDoorsOf(id);
        if (now < r.move0) { ds.forEach(d => { d.open = false; d.tAuto = 0; }); continue; }
        const t = clamp01((now - r.move0) / r.dur), e = ease(t);
        r.base = (r.p0 ?? r.from) + (r.to - (r.p0 ?? r.from)) * e;   // 起始高度单独记（途中改停靠层时以当前高度重新起步）
        {                                                         // 显示屏实时跳层：按轿厢当前高度取最近楼层，重绘电梯内外 + 所有联动门洞面板
          const fsx = liftFloors(l);
          let ck = 0, cd = Infinity;
          fsx.forEach((v, i) => { const d = Math.abs(liftFloorY(l, i) - r.base); if (d < cd) { cd = d; ck = i; } });
          if (r.dispK !== ck) { r.dispK = ck; liftAllDisp(id).forEach(p => p.setState(ck, liftLit.get(id))); }
        }
        ds.forEach(d => {
          if (d.group) d.group.position.y = r.base - r.from;      // 只移动轿厢组；联动层门固定在各自楼层
          if (d.liftSource === 'car') { d.y0 = r.base; d.y1 = r.base + (d.h ?? 2.1); }
          d.open = false; d.tAuto = 0;
        });
        for (const c of colliders) if (c.liftId === id) { c[4] = c.liftY0 + (r.base - r.from); c[5] = c.liftY1 + (r.base - r.from); }
        if (r.carry && opt.mode === 'walk') { fallY = r.base; jumpY = 0; jumpV = 0; fallV = 0; camera.position.y = eyeH + r.base; }
        if (t >= 1) {
          const fs = liftFloors(l);
          const k = Math.max(0, Math.min(fs.length - 1, r.floor | 0));
          liftRides.delete(id);
          liftQueueOf(id).delete(k);                              // 到站消灯（该层按钮熄灭）
          const dq = liftDoorReq.get(id), dreq = dq ? dq.get(k) : null; if (dq) dq.delete(k);   // 该层呼叫已服务
          mutate(() => { l.cur = k; l.stop = fs[k]; });           // 到站才写方案，2D 标注 / 3D 显示屏 / 属性面板同步更新
          sync(true);                                             // 重建后指针、碰撞、门扇都回到新楼层的静态位置（新面板按已消灯的队列绘制）
          openLiftDoors(id, r.to, dreq, k);                       // 轿厢门 + 目标层联动层门同时到站开门（按楼层索引取重建后的新门对象）
          liftRefreshDisp(id);
          liftGo.set(id, { tAt: now });                           // 门开后由队列步进等门关到位，再继续下一个已登记楼层
        }
      }
    }
    function liftFloorLabel(l, k) {                               // 楼层按钮可读标签：01 / 02 / 03…，与面板显示屏和楼层设置一致
      const fs = l && Array.isArray(l.floors) && l.floors.length ? l.floors : [l?.stop ?? 0];
      const i = Math.max(0, Math.min(fs.length - 1, Math.round(+k || 0)));
      return String(i + 1).padStart(2, '0');
    }
    function liftBtnTip(b, touch) {                               // 电梯按钮悬停提示：按动作与目标层生成，鸟瞰 / 漫游共用
      const l = (state.lifts || []).find(x => x.id === b.id);
      const fl = liftFloorLabel(l, b.floor);
      if (b.act === 'open') return touch ? tr('点开电梯门（层门同步）', 'Tap to open both doors') : tr('点 / E 开电梯门（层门同步）', 'Click / E to open both doors');
      if (b.act === 'close') return touch ? tr('点关电梯门（层门同步）', 'Tap to close both doors') : tr('点 / E 关电梯门（层门同步）', 'Click / E to close both doors');
      const lit = liftLit.get(b.id);
      const rr0 = liftRides.get(b.id);                              // 运行中：已过掉的楼层按下也不会停（亮一下即灭），先提示清楚
      if (rr0) {
        const yx = l ? liftFloorY(l, b.floor | 0) : 0;
        const dx = rr0.to > (rr0.p0 ?? rr0.from) + .005 ? 1 : rr0.to < (rr0.p0 ?? rr0.from) - .005 ? -1 : 0;
        if (dx && (yx - rr0.base) * dx <= .005) return tr(`${fl} 层已过，按了不停`, `${fl} already passed — tapping won't stop`);
      }
      if (lit && lit.has(b.floor | 0)) return tr(`${fl} 层已亮灯，到站开门`, `${fl} registered — stops on arrival`);   // 已登记：提示会依次停靠
      if (b.act === 'hall') return touch ? tr(`点呼叫电梯到 ${fl} 层`, `Tap to call the lift to ${fl}`) : tr(`点 / E 呼叫电梯到 ${fl} 层`, `Click / E to call the lift to ${fl}`);
      return touch ? tr(`点去 ${fl} 层（可多选）`, `Tap for ${fl} (multi-select)`) : tr(`点 / E 去 ${fl} 层（可多选）`, `Click / E for ${fl} (multi-select)`);
    }
    function liftBtnAct(b) {                                      // 面板按钮：楼层 = 登记亮灯（可多选，顺向依次停靠到站开门）；开关门 = 控制轿厢门
      if (!b) return;
      if (b.act === 'hall' && b.id == null) {                     // 建筑工具电梯门尚未设置联动电梯
        toast(tr('请先在电梯门设置里选择联动电梯', 'Select a linked elevator in the door settings first'));
        return;
      }
      const l = (state.lifts || []).find(x => x.id === b.id); if (!l) return;
      if (b.act === 'floor' || b.act === 'hall') {
        const fs = liftFloors(l);
        const k = Math.max(0, Math.min(fs.length - 1, b.floor | 0));
        const fl = liftFloorLabel(l, k);
        const running = liftRides.has(l.id);
        const from = liftBaseOf(l), to = liftFloorY(l, k);
        if (!running && Math.abs(to - from) < .01) {               // 就在本层：直接开门，不登记亮灯
          liftQueueOf(l.id).delete(k);
          openLiftDoors(l.id, from, b.doorId, k);
          liftRefreshDisp(l.id);
          toast(tr(`电梯已在 ${fl} 层，门已打开`, `Lift is already at ${fl} — doors opened`));
          return;
        }
        const q = liftQueueOf(l.id);
        if (q.has(k)) {                                            // 同一层重复按：不重复响应，只提示已登记
          toast(tr(`${fl} 层已登记，到站开门`, `${fl} is already registered`));
          return;
        }
        q.add(k);                                                  // 登记目标层 → 按钮亮灯
        if (b.act === 'hall' && b.doorId) { let m = liftDoorReq.get(l.id); if (!m) liftDoorReq.set(l.id, m = new Map()); m.set(k, b.doorId); }   // 记住是哪个门洞叫的，到站只开那扇层门
        if (!liftDir.has(l.id)) liftDir.set(l.id, to >= from ? 1 : -1);   // 第一次按下决定初始方向（顺向优先调度用）
        liftRefreshDisp(l.id);
        if (running) {                                             // 运行中：顺路且更近就先停这一层，否则排进队列
          const rr = liftRides.get(l.id);
          const dir = rr ? (rr.to > (rr.p0 ?? rr.from) + .005 ? 1 : rr.to < (rr.p0 ?? rr.from) - .005 ? -1 : 0) : 0;
          if (rr && dir && (to - rr.base) * dir <= .005) {         // 已经过掉的楼层：按钮亮一下（上面已刷新）随即熄灭，不排队（电梯不回头）
            const gone = () => { q.delete(k); const dq0 = liftDoorReq.get(l.id); if (dq0) dq0.delete(k); liftRefreshDisp(l.id); };
            setTimeout(gone, 260);
            toast(tr(`${fl} 层已过，不再停靠`, `${fl} already passed — no stop`));
            return;
          }
          if (liftTryInsert(l.id, k)) { toast(tr(`前方先停 ${fl} 层`, `Stopping at ${fl} first`)); return; }
          toast(tr(`已登记 ${fl} 层，将依次停靠`, `${fl} registered — stops in turn`)); return;   // 运行中只排队，不打断当前段
        }
        if (liftGo.has(l.id)) {                                    // 门正开着等关门去下一层：这次按键直接关门出发
          liftDoorsOf(l.id).forEach(d => { d.open = false; d.tAuto = 0; });
          liftGo.set(l.id, { tAt: 0 });
          return;
        }
        const next = liftNextStop(l.id, from);
        if (next != null) liftStart(l, next, b.doorId || null);
        return;
      }
      const base = liftBaseOf(l);
      const ds = liftDoorsHere(l.id, base, liftCurIdx(l.id));       // 轿厢内开 / 关门按钮：轿厢门 + 本层联动门洞的层门一起动（真实电梯两扇门同步）
      if (!ds.length) return;
      const now = performance.now();
      if (b.act === 'open') {
        if (liftRides.has(l.id)) { toast(tr('电梯运行中，到站再开门', 'Lift is moving — doors open on arrival')); return; }   // 行进中两扇门必须锁闭
        ds.forEach(d => { d.open = true; d.tAuto = now + 6000; });
        liftRefreshDisp(l.id);
        toast(ds.length > 1 ? tr('电梯门与层门已打开', 'Car and landing doors opened') : tr('电梯门已打开', 'Lift doors opened'));
      } else if (b.act === 'close') {
        if (ds.some(d => liftDoorBlocked(d, 1.2))) {               // 门口有人 / 动物：光幕挡住，保持开启（与自动关门的防夹一致）
          ds.forEach(d => { d.open = true; d.tAuto = now + 900; });
          toast(tr('门口有人，门保持打开', 'Doorway blocked — doors stay open'));
          return;
        }
        ds.forEach(d => { d.open = false; d.tAuto = 0; });
        if (liftQueueOf(l.id).size) liftGo.set(l.id, { tAt: 0 });   // 还有登记过的楼层：门一关就继续出发
        liftRefreshDisp(l.id);
        toast(ds.length > 1 ? tr('电梯门与层门已关闭', 'Car and landing doors closed') : tr('电梯门已关闭', 'Lift doors closed'));
      }
    }
    let walkTipLast = 0;
    const _tipBB = new THREE.Box3(), _tipV = new THREE.Vector3();   // 高亮包围盒 / 尺寸向量复用（避免漫游每帧分配）
    function updateDoorWalkTip() {
      const now = performance.now();
      if (now - walkTipLast < 90) return;                          // 主循环每帧调用：全场景射线拾取 + 高亮运算节流到 ~90ms 一次（瞄准提示延迟不可感知）
      walkTipLast = now;
      const walking = active && opt.mode === 'walk' && $('#walkOverlay').style.display !== 'flex';   // 未暂停
      if (!walking && stuckTip) { stuckT = 0; stuckTip.classList.remove('open'); }   // Esc 暂停 / 退出漫游时收起卡死提示
      const h = walking ? pick() : null;
      if (doorHiRef) doorHiRef.position.set(0, 0, 0);                 // 高亮层复位：门 / 旗杆挂到模型用局部坐标，灯具用世界包围盒
      if (h?.liftBtn && h.dist < 2.5 && doorHiRef && h.mesh) {        // 漫游瞄准电梯按钮：高亮命中盒 + 操作提示（点 / E 均可）
        if (doorHiRef.parent !== h.mesh) {
          const p = h.mesh.geometry.parameters;
          doorHiRef.removeFromParent(); doorHiRef.visible = true;
          doorHiRef.scale.set((p.width || .05) * 1.5, (p.height || .05) * 1.5, (p.depth || .02) + .04);
          h.mesh.add(doorHiRef);
        }
        walkTip.textContent = liftBtnTip(h.liftBtn, touchWalk);
        walkTip.classList.add('open');
      } else if ((h?.door || h?.carWin) && h.dist < 2.5 && doorHiRef) {
        if (doorHiRef.parent !== h.mesh) {                          // 高亮挂到瞄准的门扇（随开门动画一起转）
          doorHiRef.removeFromParent(); doorHiRef.visible = true;
          const p = h.mesh.geometry.parameters;                      // BufferGeometry 门玻璃无 parameters：包围盒兜底
          if (p) doorHiRef.scale.set(p.width * 1.05, p.height * 1.05, p.depth + .06);
          else { const bb = _tipBB.setFromObject(h.mesh), sz = bb.getSize(_tipV);
            bb.getCenter(doorHiRef.position); doorHiRef.scale.set(Math.max(.05,sz.x)*1.05, Math.max(.05,sz.y)*1.05, Math.max(.02,sz.z)+.06); }
          h.mesh.add(doorHiRef);
        }
        walkTip.textContent = h.carWin
          ? (touchWalk ? tr(`点按按钮${h.carWin.open?'升起':'降下'}${h.carWin.label[0]}`, `Tap to ${h.carWin.open?'raise':'lower'} ${h.carWin.label[1]}`) : tr(`E 按钮${h.carWin.open?'升起':'降下'}${h.carWin.label[0]}`, `E to ${h.carWin.open?'raise':'lower'} ${h.carWin.label[1]}`))
          : h.door.kind === 'car'
          ? (touchWalk ? tr(`点按门把手${h.door.open?'关上':'打开'}${h.door.label[0]}`, `Tap the handle to ${h.door.open?'close':'open'} ${h.door.label[1]}`) : tr(`E 门把手${h.door.open?'关上':'打开'}${h.door.label[0]}`, `E at the handle to ${h.door.open?'close':'open'} ${h.door.label[1]}`))
          : h.door.auto ? tr('自动感应门（走近自动开合）', 'Automatic door (opens as you approach)')
          : h.door.lift ? (touchWalk ? tr('点电梯门开关（稍后自动关）', 'Tap elevator door; auto-closes') : tr('点 / E 开电梯门（稍后自动关）', 'Tap / E to open; auto-closes'))
            : touchWalk ? (h.door.win ? tr('点窗开关', 'Tap to toggle') : tr('点门开关', 'Tap to toggle')) : (h.door.win ? tr('E 开关窗', 'Press E to toggle') : tr('E 开关门', 'Press E to toggle'));
        walkTip.classList.add('open');
      } else if ((h?.flagSel || h?.flagHandle) && h.dist < 2.5 && doorHiRef) {   // 瞄准旗杆（杆身 / 顶球 / 旗面）：高亮整根杆身 + 提示升降
        const ex = (state.extras || []).find(x => x.id === (h.flagSel || h.flagHandle));
        const pole = ex && archUp.children.find(o => o.userData.flagPoleFor === ex.id);
        if (pole) {
          if (doorHiRef.parent !== pole) {
            const p = pole.geometry.parameters;
            doorHiRef.removeFromParent(); doorHiRef.visible = true;
            doorHiRef.scale.set(p.radiusTop * 3.5, p.height * 1.01, p.radiusTop * 3.5);
            pole.add(doorHiRef);
          }
          walkTip.textContent = touchWalk ? tr('点旗杆升降旗', 'Tap to toggle the flag') : tr('E 升旗 / 降旗', 'Press E to raise / lower');
          walkTip.classList.add('open');
        } else { if (doorHiRef) { doorHiRef.removeFromParent(); doorHiRef.visible = false; } walkTip.classList.remove('open'); }
      } else if (h?.kind === 'lamp' && h.dist < 2.5 && doorHiRef) {    // 瞄准灯具 / 开关：高亮 + 开 / 关提示（插座无交互）
        const l = (state.lamps || []).find(x => x.id === h.id);
        if (l && !PASSIVE_LAMP_TYPES.includes(l.type)) {
          const gl = archUp.children.find(o => o.userData.pick3d?.kind === 'lamp' && String(o.userData.pick3d.id) === String(h.id));
          let shown = false;
          if (gl) {
            const bb = _tipBB.setFromObject(gl);
            if (!bb.isEmpty()) {
              const s = bb.getSize(_tipV);
              doorHiRef.removeFromParent(); doorHiRef.visible = true;
              doorHiRef.scale.set(Math.max(.05, s.x) * 1.08, Math.max(.05, s.y) * 1.08, Math.max(.05, s.z) * 1.08);
              bb.getCenter(doorHiRef.position); scene.add(doorHiRef); shown = true;
            }
          }
          if (shown) {
            const willOn = isSwitchType(l.type) ? switchTargets(l).some(x => x.on === false) : l.on === false;
            walkTip.textContent = touchWalk
              ? (willOn ? tr('点按开灯', 'Tap to turn on') : tr('点按关灯', 'Tap to turn off'))
              : (willOn ? tr('E 开灯', 'Press E to turn on') : tr('E 关灯', 'Press E to turn off'));
            walkTip.classList.add('open');
          } else { doorHiRef.removeFromParent(); doorHiRef.visible = false; walkTip.classList.remove('open'); }
        } else { doorHiRef.removeFromParent(); doorHiRef.visible = false; walkTip.classList.remove('open'); }
      } else if ((h?.kind === 'streetlamp' || h?.kind === 'solarlamp' || h?.kind === 'traflight' || h?.kind === 'facLaneLight' || h?.gateArm || h?.park) && h.dist < 3.5 && doorHiRef) {   // 瞄准路灯 / 信号灯 / 车道灯 / 道闸 / 停车场设备：整体高亮 + 动作提示（3.5m 与点按 / E 的判定距离一致）
        const ex = (state.extras || []).find(x => String(x.id) === String(h.id || h.gateArm || h.park?.id));
        const gl = ex && archUp.children.find(o => o.userData.pick3d && String(o.userData.pick3d.id) === String(ex.id) && (o.userData.pick3d.kind === ex.type || o.userData.pick3d.kind === 'extra'));
        let shown = false;
        if (gl) {
          const bb = _tipBB.makeEmpty();                             // 排除光晕精灵，高亮框只框住杆 / 悬臂 / 灯头（复用临时包围盒）
          gl.children.forEach(c => { if (!c.isSprite) bb.expandByObject(c); });
          if (!bb.isEmpty()) {
            const s = bb.getSize(_tipV);
            doorHiRef.removeFromParent(); doorHiRef.visible = true;
            doorHiRef.scale.set(Math.max(.05, s.x) * 1.08, Math.max(.05, s.y) * 1.08, Math.max(.05, s.z) * 1.08);
            bb.getCenter(doorHiRef.position); scene.add(doorHiRef); shown = true;
          }
        }
        if (shown) {
          if (ex.type === 'traflight') walkTip.textContent = (touchWalk ? tr('点按切换信号灯 · 当前', 'Tap to cycle the signal · now ') : tr('E 切换信号灯 · 当前', 'Press E to cycle the signal · now ')) + TRAFFIC_SIGNS_ZH[ex.sig || 'red'];
          else if (ex.type === 'facLaneLight') walkTip.textContent = (touchWalk ? tr('点按切换车道灯 · 当前', 'Tap to toggle lane light · now ') : tr('E 切换车道灯 · 当前', 'Press E to toggle lane light · now ')) + (ex.sig === 'green' ? tr('绿灯通行', 'green · go') : tr('红灯禁行', 'red · stop'));
          else if (ex.type === 'facBarrierGate') walkTip.textContent = ex.open === true ? (touchWalk ? tr('点按落下道闸 · 禁行', 'Tap to lower barrier · stop') : tr('E 落下道闸 · 禁行', 'Press E to lower barrier · stop')) : (touchWalk ? tr('点按抬起道闸 · 放行', 'Tap to raise barrier · go') : tr('E 抬起道闸 · 放行', 'Press E to raise barrier · go'));
          else if (h.park) {
            const k = h.park.kind, tap = touchWalk;
            walkTip.textContent = k === 'stack'
              ? (ex.st?.[h.park.cell]
                ? (tap ? tr(`点按取车 · ${h.park.lv}F ${h.park.col} 号`, `Tap to take · L${h.park.lv} no.${h.park.col}`) : tr(`E 取车 · ${h.park.lv}F ${h.park.col} 号`, `Press E to take · L${h.park.lv} no.${h.park.col}`))
                : (tap ? tr(`点按存车 · ${h.park.lv}F ${h.park.col} 号`, `Tap to park · L${h.park.lv} no.${h.park.col}`) : tr(`E 存车 · ${h.park.lv}F ${h.park.col} 号`, `Press E to park · L${h.park.lv} no.${h.park.col}`)))
              : k === 'bollard' ? (ex.up ? (tap ? tr('点按落下升降柱 · 放行', 'Tap to lower bollard · go') : tr('E 落下升降柱 · 放行', 'Press E to lower bollard · go')) : (tap ? tr('点按升起升降柱 · 禁行', 'Tap to raise bollard · stop') : tr('E 升起升降柱 · 禁行', 'Press E to raise bollard · stop')))
              : k === 'gate' ? (ex.open ? (tap ? tr('点按展开伸缩门', 'Tap to unfold gate') : tr('E 展开伸缩门', 'Press E to unfold gate')) : (tap ? tr('点按收拢伸缩门', 'Tap to fold gate') : tr('E 收拢伸缩门', 'Press E to fold gate')))
                : k === 'sensor' ? (ex.occ ? (tap ? tr('点按切为空位 · 绿灯', 'Tap to set free · green') : tr('E 切为空位 · 绿灯', 'Press E to set free · green')) : (tap ? tr('点按切为有车 · 红灯', 'Tap to set occupied · red') : tr('E 切为有车 · 红灯', 'Press E to set occupied · red')))
                  : k === 'charger' ? (ex.busy ? (tap ? tr('点按切为空闲 · 绿灯', 'Tap to set idle · green') : tr('E 切为空闲 · 绿灯', 'Press E to set idle · green')) : (tap ? tr('点按切为充电中 · 蓝灯', 'Tap to set charging · blue') : tr('E 切为充电中 · 蓝灯', 'Press E to set charging · blue')))
                    : k === 'sanSwitch' ? (ex.on ? (tap ? tr('点按关灯（门边开关）', 'Tap to turn off (wall switch)') : tr('E 关灯（门边开关）', 'Press E to turn off (wall switch)')) : (tap ? tr('点按开灯（门边开关）', 'Tap to turn on (wall switch)') : tr('E 开灯（门边开关）', 'Press E to turn on (wall switch)')))
                    : k === 'sandoor' ? (ex.doorOpen !== false
                        ? (tap ? tr('点按关门', 'Tap to close the door') : tr('E 关门', 'Press E to close the door'))
                        : (tap ? tr('点按开门', 'Tap to open the door') : tr('E 开门', 'Press E to open the door')))
                    : k === 'sancab' ? (ex.cabOpen === true
                        ? (tap ? tr('点按关上柜门', 'Tap to close the cabinet door') : tr('E 关上柜门', 'Press E to close the cabinet door'))
                        : (tap ? tr('点按打开柜门', 'Tap to open the cabinet door') : tr('E 打开柜门', 'Press E to open the cabinet door')))
                    : k === 'san' ? (() => {
                        if (ex.type === 'sanSortBin') {
                          const CN = ['蓝', '红', '绿', '灰'], EN = ['blue', 'red', 'green', 'grey'], part = h.park.part ?? 0;
                          const open = sanBinStates(ex)[part] === true, act = open ? '合上' : '打开', actEn = open ? 'close' : 'open';
                          return tap ? tr(`点按${act}${CN[part]}桶盖`, `Tap to ${actEn} the ${EN[part]} lid`) : tr(`E ${act}${CN[part]}桶盖`, `Press E to ${actEn} the ${EN[part]} lid`);
                        }
                        if (ex.type === 'sanCollectPoint' && h.park.part != null) {
                          const part = h.park.part;
                          const sv = sanVisuals.get(String(ex.id)), n = sv?.cpAnims?.length || Math.max(2, Math.round(M(ex.w || 2400) / .7));
                          const open = cpBinStates(ex, n)[part] === true, act = open ? '合上' : '打开', actEn = open ? 'close' : 'open';
                          return tap ? tr(`点按${act}第 ${part + 1} 个桶盖`, `Tap to ${actEn} bin ${part + 1} lid`) : tr(`E ${act}第 ${part + 1} 个桶盖`, `Press E to ${actEn} bin ${part + 1} lid`);
                        }
                        if (ex.type === 'sanRecycleStation' && h.park.part != null) {
                          const CN = ['蓝', '红', '绿'], EN = ['blue', 'red', 'green'], part = h.park.part;
                          const open = sanPortStates(ex)[part] === true, act = open ? '合上' : '打开', actEn = open ? 'close' : 'open';
                          return tap ? tr(`点按${act}${CN[part]}色投放口`, `Tap to ${actEn} the ${EN[part]} port`) : tr(`E ${act}${CN[part]}色投放口`, `Press E to ${actEn} the ${EN[part]} port`);
                        }
                        const S = SAN_TOAST[ex.type] || ['开启', '关闭', 'On', 'Off']; const zh = ex.on ? S[1] : S[0], en2 = ex.on ? S[3] : S[2]; return tap ? tr(`点按${zh}`, `Tap: ${en2}`) : tr(`E ${zh}`, `E: ${en2}`);
                      })()
                    : k === 'wt' ? (() => {
                        const S = WT_TOAST[ex.type] || ['开启', '关闭', 'On', 'Off']; const zh = ex.on ? S[1] : S[0], en2 = ex.on ? S[3] : S[2]; return tap ? tr(`点按${zh}`, `Tap: ${en2}`) : tr(`E ${zh}`, `E: ${en2}`);
                      })()
                    : k === 'wash' ? (ex.busy ? tr('洗车进行中 · 请稍候', 'Washing · please wait') : (tap ? tr('点按启动洗车', 'Tap to start the wash') : tr('E 启动洗车', 'Press E to start the wash')))
                      : (ex.busy ? (tap ? tr('点按切为空闲 · 绿灯', 'Tap to set idle · green') : tr('E 切为空闲 · 绿灯', 'Press E to set idle · green')) : (tap ? tr('点按切为充电中 · 蓝灯', 'Tap to set charging · blue') : tr('E 切为充电中 · 蓝灯', 'Press E to set charging · blue')));
          }
          else {
            const empty = ex.type === 'solarlamp' && (ex.battery ?? 0) <= 0;
            const onTxt = empty ? (touchWalk ? tr('点按开灯（电量不足）', 'Tap to turn on (battery empty)') : tr('E 开灯（电量不足）', 'Press E to turn on (battery empty)'))
              : (touchWalk ? tr('点按开灯', 'Tap to turn on') : tr('E 开灯', 'Press E to turn on'));
            walkTip.textContent = ex.on === false ? onTxt : (touchWalk ? tr('点按关灯', 'Tap to turn off') : tr('E 关灯', 'Press E to turn off'));
          }
          walkTip.classList.add('open');
        } else { doorHiRef.removeFromParent(); doorHiRef.visible = false; walkTip.classList.remove('open'); }
      } else if (carIdFromHit(h) != null && h.dist < 3.5 && doorHiRef) {   // 瞄准轿车车身（非门 / 灯）：整体高亮 + 上车提示
        const car = (state.extras || []).find(x => String(x.id) === String(carIdFromHit(h)));
        const gl = car && archUp.children.find(o => o.userData.pick3d?.kind === 'extra' && String(o.userData.pick3d.id) === String(car.id));
        if (gl) {
          const bb = _tipBB.makeEmpty();                             // 排除车灯光束（锥体向前伸出好几米，会把高亮框撑爆）
          gl.children.forEach(c => { if (!c.userData.driveBeam && !c.isLight) bb.expandByObject(c); });
          if (!bb.isEmpty()) {
            const s = bb.getSize(_tipV);
            doorHiRef.removeFromParent(); doorHiRef.visible = true;
            doorHiRef.scale.set(Math.max(.05, s.x) * 1.04, Math.max(.05, s.y) * 1.04, Math.max(.05, s.z) * 1.04);
            bb.getCenter(doorHiRef.position); scene.add(doorHiRef);
          }
        }
        walkTip.textContent = touchWalk ? tr('点按上车', 'Tap to get in') : tr('E / F 上车', 'Press E / F to get in');
        walkTip.classList.add('open');
      } else {
        if (doorHiRef) { doorHiRef.removeFromParent(); doorHiRef.visible = false; }
        walkTip.classList.remove('open');
      }
    }
    function loop() {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), .05), now = performance.now();
      liftRideStep(now);                                        // 电梯运行：先更新轿厢 / 碰撞 / 玩家落脚高度，再走漫游物理
      liftQueueStep(now);                                       // 到站开门 → 门关到位 → 继续下一个已登记楼层（多层排队）
      if (anim) { const t = clamp01((now - anim.t0) / anim.dur); anim.fn(t); if (t >= 1) { const r = anim.res; anim = null; r(); } }
      else if (fly) { const t = clamp01((now - fly.t0) / fly.dur); camTween(fly.A, fly.B, ease(t)); if (t >= 1) fly = null; }
      else if (opt.mode === 'orbit') orbit.update();
      else if (!liftCarrying()) { if (driveCar) stepDrive(dt); else stepWalk(dt); }   // 驾驶中由 stepDrive 接管（车动相机随），否则正常漫游
      doors.forEach(d => {                                   // 自动感应门：玩家 / 动物靠近自动滑开、离开关上（漫游态检测玩家，两种模式均检测漫步中的动物）
        if (!d.auto) return;
        const doff = d.yOff || 0;                               // 其它楼层自动门存局部高度，感应判定统一换算到世界高度
        let near = false;
        if (opt.mode === 'walk') {
          const dist = Math.hypot(camera.position.x - d.mx, camera.position.z - d.mz);      // 玩家到门中心的水平距离
          near = dist < Math.max(1.8, d.half + 1.6) && camera.position.y > d.base + doff - .3 && camera.position.y < d.top + doff + .5;   // 接近门宽+余量，且玩家高度落在门洞附近（避免隔层触发）
        }
        if (!near) for (const g of furnG.children) {          // 动物感应：漫步靠近门也会触发开门，高度不在门洞附近（隔层）不触发
          if (!g.userData.poultry) continue;
          if (g.position.y < d.base + doff - .3 || g.position.y > d.top + doff + .5) continue;
          if (Math.hypot(g.position.x - d.mx, g.position.z - d.mz) < Math.max(1.5, d.half + 1)) { near = true; break; }
        }
        d.open = near;
      });
      doors.forEach(d => {                                  // 电梯门自动关门（漫游 / 鸟瞰 / 3D 预览均生效）：开门 6 秒后关，光幕被挡则顺延
        if (!d.lift || !d.open || !d.tAuto) return;
        if (d.liftId != null && liftRides.has(d.liftId)) return;             // 运行中由运行逻辑强制关门，这里不插手
        if (now <= d.tAuto) return;
        if (liftDoorBlocked(d)) { d.tAuto = now + 900; return; }             // 门口有人 / 动物：保持开启，人离开后再关
        d.open = false; d.tAuto = 0;
      });
      doors.forEach(d => {                                  // 关门途中被光幕挡到 → 立即反向开门（防夹），同一扇门 1.5 秒内只提示一次
        if (!d.lift || d.open || !(d.cur > .04) || (d.liftId != null && liftRides.has(d.liftId))) return;
        if (!liftDoorBlocked(d, 1.2)) return;
        d.open = true; d.tAuto = now + 6000;
        if (opt.mode === 'walk' && !(d.pinchT && now - d.pinchT < 1500)) {
          d.pinchT = now;
          toast(tr('门口有人，电梯门已重新打开', 'Door blocked — lift door reopened'));
        }
      });
      doors.forEach(d => { const tg = d.open ? (d.a1 ?? 1) : (d.a0 ?? 0); d.cur += (tg - d.cur) * Math.min(1, dt * 6); if (d.slide) d.pivots.forEach(p => { const k = p.tph ? Math.max(0, d.cur * 2 - 1) : d.cur, r = p.tph ? Math.min(1, d.cur * 2) : d.cur;   // tph = 两段式：前半程先升起、后半程再平移（轿车天窗）
        p.g.position.set(p.px + p.ax * p.dist * k, (p.ay || 0) * r, p.pz + p.az * p.dist * k); }); else if (d.slat) d.grp.scale.y = Math.max(.02, d.cur); else if (d.fold) d.parts.forEach(p => p.g.rotation.y = p.a * d.cur); else d.pivot.rotation[d.axis || 'y'] = d.cur; });   // slide = 平移门（电梯门双扇同步 / 轿车天窗两段式）/ slat = 卷帘门向上卷收 / fold = 折叠门折起 / axis:z = 轿车机盖与尾门绕横轴掀起
      gateArms.forEach(g => { const tg = g.open ? g.a1 : g.a0; g.cur += (tg - g.cur) * Math.min(1, dt * 4); if (g.pivot) g.pivot.rotation.z = g.cur; });   // 道闸机闸杆升降动画：落下 0 → 抬起 +1.35rad（向上）
      parkAnims.forEach(a => { const tg = a.open ? 1 : 0; a.cur += (tg - a.cur) * Math.min(1, dt * 5); a.apply(a.cur); });   // 停车场配套：升降柱上下 / 伸缩门收拢展开
      wtRuns.forEach(r => { if (r.g) r.g.position.x = r.on ? r.x0 + Math.abs(Math.sin(now * .0035)) * r.range : r.x0; });   // 垃圾转运站：压缩机运行中推杆往复，停止时复位
      carWashStep(now, dt);                                     // 自动洗车机：按洗车时间轴驱动龙门 / 滚刷 / 水雾 / 车辆
      for (let i = stackOps.length - 1; i >= 0; i--) { const o = stackOps[i]; o.t += dt; const k = Math.min(1, o.t / o.dur); stackApply(o, k); if (k >= 1) stackOps.splice(i, 1); }   // 立体车库：载车板下降换车再升回
      revolveSpins.forEach(g => { g.rotation.y += dt * .7; });   // 旋转门三翼持续匀速转动（约 9 秒一圈），鸟瞰 / 漫游均生效
      escSteps.forEach(st => {                                  // 自动扶梯梯级闭环循环（沿路径约 0.35 m/s 匀速）：骑行斜面梯面保持水平，两端沿圆弧回转翻转 180°沉入端部平台下方，斜面下方倒挂平行回程，形成真实连贯的循环转动；单跑 / 多跑每跑按各自闭环参数取位
        const e = st.userData.esc, t = ((e.i + .5) * e.pitch + (now * .00035) % e.pitch) % e.S;
        const q = escLoopPos(e, t);
        st.position.x = q.x; st.position.y = q.y; if (e.z !== undefined) st.position.z = e.z;
        st.rotation.z = q.r;
      });
      // 家禽随机漫步：在放置点半径内选无障碍目标慢行、停歇；带平滑转向与步态，避开墙 / 门扇 / 家具 / 栏杆，旋转门翼扫到会被推走（与人一致，鸟瞰 / 漫游均生效）
      furnG.children.forEach(g => {
        const p = g.userData.poultry; if (!p) return;
        let dx = p.tx - g.position.x, dz = p.tz - g.position.z, dist = Math.hypot(dx, dz);
        if (p.wait > 0) p.wait -= dt;
        else if (dist < .04 || !poultryFree(p.tx, p.tz, g)) {              // 到达或目标被占：从当前位置朝随机方向选一个较远且整段可达的目标
          let ok = false;
          for (let k = 0; k < 30 && !ok; k++) {
            const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 3.5, ux = Math.cos(a), uz = Math.sin(a);
            const nx = g.position.x + ux * r, nz = g.position.z + uz * r;
            if (Math.hypot(nx - p.homeX, nz - p.homeZ) > p.roam) continue;   // 离放置点不超过 10m
            let clear = true;
            for (let s = .25; s <= r; s += .25) if (!poultryFree(g.position.x + ux * s, g.position.z + uz * s, g)) { clear = false; break; }
            if (clear && poultryFree(nx, nz, g)) { p.tx = nx; p.tz = nz; ok = true; }
          }
          if (!ok) { p.tx = p.homeX; p.tz = p.homeZ; }
          p.wait = .3 + Math.random() * 1.2; dx = p.tx - g.position.x; dz = p.tz - g.position.z; dist = Math.hypot(dx, dz);
        }
        if (p.wait <= 0 && dist >= .04) {
          const step = Math.min(p.speed * dt * (p.hop ? Math.max(.08, Math.sin(p.gait)) : 1), dist), nx = g.position.x + dx / dist * step, nz = g.position.z + dz / dist * step;   // 跳跃步态（兔子）：只在腾空半周期快速前进，落地半周期近乎停顿，呈一跳一停的节奏
          if (poultryFree(nx, nz, g)) { g.position.x = nx; g.position.z = nz; p.gait += dt * 9; }   // 下一脚落点无障碍才前进（含其他家禽占位）
          else { p.wait = 0; p.tx = g.position.x; p.tz = g.position.z; }                           // 撞到边缘：立即原地重选目标，避免卡住
          const want = Math.atan2(-dx, -dz); let diff = ((want - p.heading + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
          p.heading += diff * Math.min(1, dt * 3); g.rotation.y = p.heading;
        }
        pushOutOfRevolve(g.position, 0, .3, .12);                // 旋转门翼扫到家禽：与人一样被翼推走（翼逐帧转动会扫过静止的家禽，推开避免穿模）
        const moving = p.wait <= 0 && dist >= .04, t = now * .001 + p.phase;
        if (p.hop) {                                             // 兔子：跳跃步态——每个步态周期一跳：腾空半周期身体划抛物线（起跳仰头 → 顶点放平 → 落地前倾），落地半周期停顿蓄力；前爪前伸、后腿后蹬（相位相反），四条腿一起动
          const air = moving ? Math.sin(p.gait) : 0, up = air > 0;
          p.body.position.y = up ? air * .08 : Math.sin(t * 2.2) * .008;
          p.body.rotation.x = up ? Math.cos(p.gait) * .18 : 0;
          p.body.rotation.z = up ? 0 : Math.sin(t * 1.3) * .02;
          p.head.rotation.x = up ? -Math.cos(p.gait) * .08 : Math.sin(t * 3.1) * .16 - .06;
          p.legs.forEach((lg, i) => { lg.rotation.x = up ? Math.cos(p.gait) * (i < 2 ? .7 : -.75) : 0; });
        } else if (p.slither) {                                  // 蛇：无腿，身体左右摆行
          p.body.rotation.y = moving ? Math.sin(p.gait) * .3 : Math.sin(t * 1.3) * .06;
          p.body.position.y = Math.sin(t * 2.2) * .004;
          p.head.rotation.x = moving ? Math.sin(p.gait * .5) * .1 : Math.sin(t * 3.1) * .08;
        } else {
          p.body.position.y = moving ? Math.abs(Math.sin(p.gait)) * .018 : Math.sin(t * 2.2) * .008;
          p.body.rotation.z = moving ? Math.sin(p.gait) * .045 : Math.sin(t * 1.3) * .02;
          p.head.rotation.x = moving ? Math.sin(p.gait * .5) * .12 : Math.sin(t * 3.1) * .16 - .06;
          p.legs[0].rotation.x = moving ? Math.sin(p.gait) * .5 : 0;
          p.legs[1].rotation.x = moving ? -Math.sin(p.gait) * .5 : 0;
        }
      });
      if (opt.mode === 'walk' && !driveCar) pushOutOfRevolve(camera.position, camera.position.y - eyeH, headH);   // 漫游时翼扫到玩家则推开，避免穿模（驾驶中相机在车内，不参与）
      if (driveCar) { if (walkTip) { walkTip.textContent = touchWalk ? tr('点按「下车」退出', 'Tap "Exit" to get out') : tr('WASD 驾驶 · Shift 加速 · 空格刹车 · E / F 下车', 'WASD drive · Shift boost · Space brake · E / F exit'); walkTip.classList.add('open'); } }
      else updateDoorWalkTip();
      flagAnims.forEach((a, id) => {                             // 旗面升降：逐帧插值旗面高度；播完只写状态并入撤销栈，不走 buildArch 重建（否则门窗动画会被重置）
        const k = clamp01((now - a.t0) / a.dur), v = (a.from + (a.to - a.from) * ease(k)) / 1000;
        const fw = Math.max(.5, a.top / 10000), fh = fw * .62;   // a.top 是毫米，换算成米
        const mesh = archUp.children.find(o => o.userData.flagMeshFor === id);
        if (mesh) mesh.position.y = v - fh / 2;
        if (k >= 1) {
          flagAnims.delete(id);
          commit(snap());                                        // 快照此刻（旧 flagY）入撤销栈
          const ex = (state.extras || []).find(x => x.id === id);
          if (ex) { ex.flagY = a.to; markDirty(); renderPanel(); }
        }
      });
      stepFx(dt);
      stepSurveillance(now);                                     // 安防监控：离屏取景 + 合成实时画面到显示器（节流，取景时隐藏屏幕）
      updateSel();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }

    const flagAnims = new Map();                                   // 旗面升降动画：id → {from,to,top,t0,dur}（仿门开关的逐帧过渡）

    function startFlagAnim(ex) {                                   // 旗面升起 ⇄ 降下：先播动画，结束才写入方案（鸟瞰点击 / 漫游 E 键 / 漫游点击共用）
      if (!ex || flagAnims.has(ex.id)) return;
      const top = ex.h ?? 6000, up = (ex.flagY ?? Math.round(top * .9)) > top * .6;
      flagAnims.set(ex.id, { from: ex.flagY ?? Math.round(top * .9), to: up ? 800 : top - 500, top, t0: performance.now(), dur: 900 });
    }

    function shot() { const a = document.createElement('a'); a.download = tr('户型装修方案', 'floor-plan-design') + '-3D.png'; a.href = renderer.domElement.toDataURL('image/png'); a.click(); }

    function relang() { syncWalkTexts(); if (inited) buildLabels(); }
    function getAllFloors() { return !!opt.allFloors; }
    function setAllFloors(on, fly = true) {
      opt.allFloors = !!on;
      if (typeof renderFloorBar === 'function') renderFloorBar();   // 同步楼层条中「全楼层 / 1F / 2F」的高亮
      if (inited) sync();
      if (fly && active && opt.mode === 'orbit') flyTo(opt.allFloors ? allFloorsPose() : isoWhole());
      toast(opt.allFloors
        ? tr('已显示整栋楼：可沿楼梯 / 电梯走到其它楼层', 'Whole building shown: walk between floors via stairs / lifts')
        : tr('已恢复当前楼层视图', 'Back to current-floor view'));
    }
    function setSlabVis(on) {                                   // 楼板开关：即时翻转所有楼层的楼板网格可见性，不重建场景
      opt.slabs = on !== false;
      const v = opt.slabs;
      const roots = [archUp, archFloor];
      if (opt.allFloors && stackGroup) roots.push(stackGroup);   // 整栋模式：其它楼层的楼板挂在 stackGroup 的各层子组里，必须与当前层一起翻转，否则开关只管一层
      roots.forEach(root => root && root.traverse(o => {
        if (!o.isMesh || (o.userData && o.userData.ceilMesh)) return;
        const ud = o.userData || {};
        if (ud.room || (ud.pick3d && ud.pick3d.kind === 'slab')) o.visible = v;
      }));
      const b = document.querySelector('#toggles3d [data-t="slabs"]');
      if (b) b.classList.toggle('on', v);
      ui.layers.slab = v;                                       // 与图层设置保持一致（随方案保存）
    }

    window.View3D = { enter, exit, relang, getAllFloors, setAllFloors, setSlabVis, sync: force => sync(force), onFloorChanged, shot, groundAt, pick: (x, y) => pick({ clientX: x, clientY: y }), doorsRef: doors, flyToRoom: id => active && !anim && flyToRoom(id), walking: () => active && opt.mode === 'walk', __dbg: { get scene() { return archUp; }, get furnG() { return furnG; }, get lampG() { return lampG; }, get escSteps() { return escSteps; }, stairH, stairLayout, worldDatasets, escCarry, blocked, ladderAt, toggleLamp, get floorWorlds() { return floorWorlds; }, get camera() { return camera; }, get orbit() { return orbit; }, get dbgLadder() { return { fallY, ladderOn: ladderOn && ladderOn.id, keysW: !!keys.KeyW, touchWalk, mode: opt.mode }; }, liftStart, setMode, get state() { return state; }, get fallY() { return fallY; }, setFoot(v) { fallY = v; fallV = 0; jumpY = 0; jumpV = 0; camera.position.y = eyeH + v; } } };
  