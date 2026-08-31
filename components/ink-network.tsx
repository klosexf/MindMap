'use client';

import { useEffect, useRef } from 'react';

/**
 * 首页氛围层：宣纸上的活墨导图。
 * - Canvas 墨点网络：节点呼吸漂移、新连线落笔生长、鼠标引力、脉冲墨滴
 * - .ink-fx：纸色渐变洗白层（保证左侧文字对比度）
 * - .ink-grain：极淡纸张颗粒（multiply，pointer-events: none）
 * 亮色体系下不用辉光，全部以透明度分层模拟「宣纸洇墨」。
 */
export function InkNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return undefined;
    const ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return undefined;
    // 闭包内保持非空类型（函数声明会被提升，直接收窄在闭包里会失效）
    const canvas = canvasEl;
    const ctx = ctx2d;

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    const REDUCED =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const MAX_NODES = 60;
    const INITIAL = 32;
    const MARGIN = 56;

    interface InkNode {
      hx: number;
      hy: number;
      depth: number;
      r: number;
      phase: number;
      breath: number;
      d1: number;
      s1: number;
      p1: number;
      d2: number;
      s2: number;
      p2: number;
      opacity: number;
      maxOpacity: number;
      mox: number;
      moy: number;
      dying: boolean;
      x: number;
      y: number;
    }

    interface InkEdge {
      a: InkNode;
      b: InkNode;
      p: number;
      dur: number;
      curv: number;
      heavy: boolean;
    }

    interface InkPulse {
      e: InkEdge;
      t: number;
      dur: number;
      dir: number;
    }

    const nodes: InkNode[] = [];
    const edges: InkEdge[] = [];
    const pulses: InkPulse[] = [];
    const mouse = { x: -9999, y: -9999, active: false };

    // 预渲染软墨点 sprite：极淡「洇墨」晕，而非辉光
    const softSprite = (() => {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const g = c.getContext('2d');
      if (!g) return c;
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(26,26,26,0.16)');
      grad.addColorStop(0.3, 'rgba(26,26,26,0.06)');
      grad.addColorStop(0.62, 'rgba(26,26,26,0.015)');
      grad.addColorStop(1, 'rgba(26,26,26,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      return c;
    })();

    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const easeOut = (p: number) => 1 - (1 - p) * (1 - p);

    function createNode(x: number, y: number, depth: number): InkNode {
      return {
        hx: x,
        hy: y,
        depth,
        r: depth === 0 ? 3.8 : Math.max(2.0, 3.1 - depth * 0.22) + rand(-0.15, 0.15),
        phase: rand(0, Math.PI * 2),
        breath: rand(0.5, 1.1),
        d1: rand(8, 20),
        s1: rand(0.00005, 0.00011),
        p1: rand(0, 6.283),
        d2: rand(8, 20),
        s2: rand(0.00004, 0.0001),
        p2: rand(0, 6.283),
        opacity: 0,
        maxOpacity: depth === 0 ? 0.7 : Math.max(0.15, 0.55 - (depth - 1) * 0.09),
        mox: 0,
        moy: 0,
        dying: false,
        x,
        y,
      };
    }

    const edgeAlpha = (depth: number) => Math.max(0.05, 0.115 - depth * 0.011);

    function pickParent(): InkNode | null {
      const cand: InkNode[] = [];
      for (const n of nodes) {
        if (!n.dying && n.depth <= 5) cand.push(n);
      }
      if (!cand.length) return null;
      let total = 0;
      const weights = cand.map((n) => {
        const w = 1 / (n.depth + 1);
        total += w;
        return w;
      });
      let r = Math.random() * total;
      for (let i = 0; i < cand.length; i++) {
        r -= weights[i];
        if (r <= 0) return cand[i];
      }
      return cand[cand.length - 1];
    }

    function addNode(parent: InkNode | null, instant: boolean): InkNode | null {
      if (!parent) return null;
      let x = 0;
      let y = 0;
      let ok = false;
      let tries = 0;
      while (!ok && tries < 10) {
        tries++;
        const ang = rand(0, Math.PI * 2);
        const dist = rand(72, 170);
        x = parent.hx + Math.cos(ang) * dist;
        y = parent.hy + Math.sin(ang) * dist * 0.82;
        if (x < MARGIN || x > W - MARGIN || y < MARGIN || y > H - MARGIN) continue;
        ok = true;
        for (const n of nodes) {
          if (n.dying) continue;
          const dx = n.hx - x;
          const dy = n.hy - y;
          if (dx * dx + dy * dy < 40 * 40) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) return null;
      const node = createNode(x, y, parent.depth + 1);
      nodes.push(node);
      edges.push({
        a: parent,
        b: node,
        p: instant ? 1 : 0,
        dur: rand(1300, 2100),
        curv: rand(-26, 26),
        heavy: Math.random() < 0.35,
      });
      if (instant) node.opacity = node.maxOpacity;
      return node;
    }

    function seed() {
      nodes.length = 0;
      edges.length = 0;
      pulses.length = 0;
      const r1 = createNode(W * 0.72, H * 0.34, 0);
      r1.opacity = r1.maxOpacity;
      nodes.push(r1);
      const r2 = createNode(W * 0.86, H * 0.66, 0);
      r2.maxOpacity = 0.5;
      r2.opacity = 0.5;
      nodes.push(r2);
      const r3 = createNode(W * 0.26, H * 0.9, 0);
      r3.maxOpacity = 0.42;
      r3.opacity = 0.42;
      nodes.push(r3);
      for (let i = 0; i < INITIAL; i++) addNode(pickParent(), true);
    }

    interface EdgePts {
      ax: number;
      ay: number;
      cx: number;
      cy: number;
      bx: number;
      by: number;
    }

    function edgePts(e: InkEdge): EdgePts {
      const mx = (e.a.x + e.b.x) / 2;
      const my = (e.a.y + e.b.y) / 2;
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      return {
        ax: e.a.x,
        ay: e.a.y,
        cx: mx - (dy / len) * e.curv,
        cy: my + (dx / len) * e.curv,
        bx: e.b.x,
        by: e.b.y,
      };
    }

    function qpoint(p: EdgePts, t: number) {
      const u = 1 - t;
      return {
        x: u * u * p.ax + 2 * u * t * p.cx + t * t * p.bx,
        y: u * u * p.ay + 2 * u * t * p.cy + t * t * p.by,
      };
    }

    let last = 0;
    let nextGrow = 1600;
    let nextPulse = 2600;
    let nextRecycle = 4200;

    function update(t: number, dt: number) {
      const R = 170;
      for (const n of nodes) {
        const dx = Math.sin(t * n.s1 + n.p1) * n.d1;
        const dy = Math.cos(t * n.s2 + n.p2) * n.d2;
        let tx = 0;
        let ty = 0;
        if (mouse.active) {
          const px = n.hx + dx - mouse.x;
          const py = n.hy + dy - mouse.y;
          const dd = px * px + py * py;
          if (dd < R * R && dd > 0.01) {
            const d = Math.sqrt(dd);
            const f = (1 - d / R) * 16;
            tx = (-px / d) * f;
            ty = (-py / d) * f;
          }
        }
        n.mox += (tx - n.mox) * 0.055;
        n.moy += (ty - n.moy) * 0.055;
        n.x = n.hx + dx + n.mox;
        n.y = n.hy + dy + n.moy;
        const target = n.dying ? 0 : n.maxOpacity;
        n.opacity += (target - n.opacity) * (n.dying ? 0.03 : 0.025);
      }

      for (const e of edges) {
        if (e.p < 1) e.p = Math.min(1, e.p + dt / e.dur);
      }

      // 移除淡出的节点及其边
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.dying && n.opacity < 0.02) {
          for (let j = edges.length - 1; j >= 0; j--) {
            if (edges[j].a === n || edges[j].b === n) {
              for (let k = pulses.length - 1; k >= 0; k--) {
                if (pulses[k].e === edges[j]) pulses.splice(k, 1);
              }
              edges.splice(j, 1);
            }
          }
          nodes.splice(i, 1);
        }
      }

      // 生长新连线
      if (t > nextGrow) {
        nextGrow = t + rand(1900, 3400);
        let alive = 0;
        for (const n of nodes) if (!n.dying) alive++;
        if (alive < MAX_NODES) addNode(pickParent(), false);
      }

      // 回收叶节点，保持导图持续演化
      if (t > nextRecycle) {
        nextRecycle = t + rand(3600, 6000);
        let alive2 = 0;
        for (const n of nodes) if (!n.dying) alive2++;
        if (alive2 >= MAX_NODES - 3) {
          const leaves: InkNode[] = [];
          for (const n of nodes) {
            if (n.dying || n.depth < 2) continue;
            let isLeaf = true;
            for (const e of edges) {
              if (e.a === n) {
                isLeaf = false;
                break;
              }
            }
            if (isLeaf) leaves.push(n);
          }
          if (leaves.length) leaves[Math.floor(Math.random() * leaves.length)].dying = true;
        }
      }

      // 沿成熟连线的游走墨滴
      if (t > nextPulse) {
        nextPulse = t + rand(3200, 6200);
        const grown: InkEdge[] = [];
        for (const e of edges) {
          if (e.p >= 1 && !e.a.dying && !e.b.dying) grown.push(e);
        }
        if (grown.length) {
          pulses.push({
            e: grown[Math.floor(Math.random() * grown.length)],
            t: 0,
            dur: rand(1100, 1700),
            dir: Math.random() < 0.5 ? 1 : -1,
          });
          if (pulses.length > 3) pulses.shift();
        }
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].t += dt;
        if (pulses[i].t > pulses[i].dur) pulses.splice(i, 1);
      }
    }

    function draw(t: number) {
      ctx.clearRect(0, 0, W, H);

      // 连线：石墨笔触
      ctx.lineCap = 'round';
      for (const e of edges) {
        const pts = edgePts(e);
        const tt = easeOut(e.p);
        const end = qpoint(pts, tt);
        const ctrlX = pts.ax + (pts.cx - pts.ax) * tt;
        const ctrlY = pts.ay + (pts.cy - pts.ay) * tt;
        const depth = Math.max(e.a.depth, e.b.depth);
        const ratioA = e.a.opacity / e.a.maxOpacity;
        const ratioB = e.b.opacity / e.b.maxOpacity;
        let alpha = edgeAlpha(depth) * Math.min(ratioA, e.p < 1 ? 1 : ratioB);
        if (e.heavy) alpha *= 1.25;
        if (e.p < 1) alpha = Math.min(0.12, alpha * 1.9 + 0.05);
        alpha = Math.min(0.12, alpha);
        ctx.strokeStyle = `rgba(26,26,26,${alpha.toFixed(3)})`;
        ctx.lineWidth = e.p < 1 ? 1.15 : e.heavy ? 1.05 : 0.9;
        ctx.beginPath();
        ctx.moveTo(pts.ax, pts.ay);
        ctx.quadraticCurveTo(ctrlX, ctrlY, end.x, end.y);
        ctx.stroke();
        if (e.p < 1) {
          // 生长末端：深墨点 + 淡洇
          ctx.globalAlpha = 0.55;
          ctx.drawImage(softSprite, end.x - 12, end.y - 12, 24, 24);
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(26,26,26,0.35)';
          ctx.beginPath();
          ctx.arc(end.x, end.y, 1.8, 0, 6.2832);
          ctx.fill();
        }
      }

      // 脉冲墨滴
      for (const pu of pulses) {
        const k = pu.t / pu.dur;
        const along = pu.dir > 0 ? k : 1 - k;
        const pts = edgePts(pu.e);
        const pos = qpoint(pts, along);
        const fade = Math.sin(k * Math.PI);
        ctx.globalAlpha = fade * 0.5;
        ctx.drawImage(softSprite, pos.x - 10, pos.y - 10, 20, 20);
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(26,26,26,${(0.38 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 1.5, 0, 6.2832);
        ctx.fill();
      }

      // 节点：呼吸墨点
      for (const n of nodes) {
        const br = 0.68 + 0.32 * Math.sin(t * 0.0009 * n.breath + n.phase);
        const size = n.r * (n.depth === 0 ? 10 : 7.5);
        ctx.globalAlpha = n.opacity * br * 0.55;
        ctx.drawImage(softSprite, n.x - size / 2, n.y - size / 2, size, size);
        ctx.globalAlpha = 1;
        const rr = n.r * (1 + 0.12 * Math.sin(t * 0.0009 * n.breath + n.phase));
        const ca = n.opacity * (0.72 + 0.28 * br);
        ctx.fillStyle = `rgba(26,26,26,${ca.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr, 0, 6.2832);
        ctx.fill();
        if (n.depth === 0) {
          ctx.strokeStyle = `rgba(26,26,26,${(0.2 * n.opacity * br).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(n.x, n.y, rr + 5 + 1.5 * Math.sin(t * 0.0006 + n.phase), 0, 6.2832);
          ctx.stroke();
        }
      }
    }

    let raf = 0;

    function frame(t: number) {
      if (!last) last = t;
      const dt = Math.min(50, t - last);
      last = t;
      update(t, dt);
      draw(t);
      raf = requestAnimationFrame(frame);
    }

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (W && H) {
        const rx = w / W;
        const ry = h / H;
        for (const n of nodes) {
          n.hx *= rx;
          n.hy *= ry;
        }
      }
      W = w;
      H = h;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (REDUCED) draw(1200);
    }

    function onMouseMove(ev: MouseEvent) {
      mouse.x = ev.clientX;
      mouse.y = ev.clientY;
      mouse.active = true;
    }

    function onMouseOut() {
      mouse.active = false;
    }

    resize();
    seed();

    if (REDUCED) {
      // 静态墨图：全量生长，不进动画循环
      let guard = 0;
      while (nodes.length < MAX_NODES && guard++ < 200) {
        if (!addNode(pickParent(), true)) break;
      }
      for (const n of nodes) n.opacity = n.maxOpacity;
      draw(1200);
    } else {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseout', onMouseOut);
      window.addEventListener('resize', resize);
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="ink-net" aria-hidden="true" />
      <div className="ink-fx" aria-hidden="true" />
      <div className="ink-grain" aria-hidden="true" />
    </>
  );
}
