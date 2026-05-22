import './styles.css'

const app = document.querySelector<HTMLDivElement>('#app')

if (app) {
  app.innerHTML = `
    <section class="shell">
      <div class="brand">
        <span class="mark">A</span>
        <div>
          <h1>AgentWFY Mobile</h1>
          <p>Tauri shell is ready.</p>
        </div>
      </div>
      <div class="panel">
        <span class="status-dot"></span>
        <span>Remote-only mobile client scaffold</span>
      </div>
    </section>
  `
}
