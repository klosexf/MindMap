import { GenerateForm } from '@/components/generate-form';
import { SavedMindMaps } from '@/components/saved-mindmaps';

export default function HomePage() {
  return (
    <>
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

      <main className="page home-page">
        <section className="hero-section">
          <h1 className="hero-title">把任何长内容变成思维导图</h1>
        </section>

        <section className="home-input-block">
          <GenerateForm />
        </section>

        <section className="home-examples" aria-label="快速示例">
          <p className="examples-label">试试这些：</p>
          <div className="examples-grid">
            <span className="tag-pill">Attention Is All You Need</span>
            <span className="tag-pill">GPT 教程视频链接</span>
            <span className="tag-pill">行业研究 PDF</span>
            <span className="tag-pill">React Hooks 知识梳理</span>
          </div>
        </section>

        <section id="features" className="cards-grid">
          <article className="card-glass card-feature">
            <h3 className="card-feature-title">智能功能</h3>
            <svg className="card-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <ul className="card-feature-list">
              <li>PDF智能解析</li>
              <li>视频转录分析</li>
              <li>AI智能助手</li>
              <li>节点关联链接</li>
            </ul>
          </article>

          <article id="stats" className="card-glass card-stats">
            <div className="avatar-group" aria-label="用户头像组">
              <span className="avatar">张</span>
              <span className="avatar">李</span>
              <span className="avatar">王</span>
              <span className="avatar">+5K</span>
            </div>

            <div className="star-rating" aria-label="5 星评分">
              <span>★</span>
              <span>★</span>
              <span>★</span>
              <span>★</span>
              <span>★</span>
            </div>

            <div className="card-stats-number">45,231</div>
            <div className="card-stats-label">已生成导图</div>
          </article>
        </section>
      </main>

      <footer className="trust-bar">
        <div className="trust-bar-inner">
          <span>单人本地闭环：输入 → 生成 → 编辑 → 导出</span>
          <span className="trust-badge">无需登录</span>
        </div>
      </footer>
    </>
  );
}
