import { GenerateForm } from '@/components/generate-form';
import { InkNetwork } from '@/components/ink-network';
import { SavedMindMaps } from '@/components/saved-mindmaps';

const FEATURES = [
  { idx: '01', name: 'PDF智能解析' },
  { idx: '02', name: '视频转录分析' },
  { idx: '03', name: 'AI智能助手' },
  { idx: '04', name: '节点关联链接' },
];

function Star() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="#1a1a1a" aria-hidden="true">
      <path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.2l7.1-.6z" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <>
      <InkNetwork />

      <header className="home-navbar">
        <div className="home-navbar-inner">
          <a href="/" className="brand-link" aria-label="返回首页">
            <span className="brand-mark">M</span>
            <span className="brand-name">MindMap AI</span>
          </a>
          <div className="home-nav-right">
            <nav className="home-nav-links">
              <a href="#features">功能特性</a>
              <a href="#stats">用户口碑</a>
            </nav>
            <SavedMindMaps />
          </div>
        </div>
      </header>

      <main className="home-page">
        <div className="page">
          <section className="hero-section">
            <h1 className="hero-title">
              把任何长内容
              <br />
              变成
              <span className="hero-title-accent">
                思维导图
                <svg
                  className="hero-inkline"
                  viewBox="0 0 230 14"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <path d="M4 9 C 62 3.5, 158 3.2, 226 7.5" pathLength="100" />
                </svg>
              </span>
            </h1>
            <p className="hero-subtitle">粘贴文本、URL 或上传 PDF，AI 在几秒内梳理出清晰的知识结构</p>
          </section>

          <section className="home-input-block">
            <GenerateForm />
          </section>
        </div>

        <section id="features" className="home-band">
          <div className="page cards-grid">
            <div id="stats" className="band-cell">
              <div className="band-stat-num">45,231</div>
              <div className="band-stat-row">
                <span className="band-stars" aria-label="5 星评分">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Star key={i} />
                  ))}
                </span>
                <span>已生成导图 · 5 星评分</span>
              </div>
            </div>
            {FEATURES.map((feature) => (
              <div key={feature.idx} className="band-cell">
                <div className="band-idx">{feature.idx}</div>
                <div className="band-name">{feature.name}</div>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="trust-bar">
        <div className="trust-bar-inner">
          <span>单人本地闭环：输入 -&gt; 生成 -&gt; 编辑 -&gt; 导出</span>
          <span className="trust-badge">无需登录</span>
        </div>
      </footer>
    </>
  );
}
