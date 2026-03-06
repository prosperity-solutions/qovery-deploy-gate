import { FastifyInstance } from "fastify";

export function registerUI(app: FastifyInstance) {
  app.get("/ui", async (_request, reply) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deploy Gate - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      line-height: 1.6;
    }

    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0 24px;
      border-bottom: 1px solid #21262d;
      margin-bottom: 24px;
    }

    header h1 {
      font-size: 24px;
      font-weight: 600;
      color: #f0f6fc;
    }

    header h1 span {
      color: #58a6ff;
    }

    .refresh-info {
      font-size: 13px;
      color: #8b949e;
    }

    .section-title {
      font-size: 18px;
      font-weight: 600;
      color: #f0f6fc;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-title .badge {
      font-size: 12px;
      background: #21262d;
      color: #8b949e;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 400;
    }

    .badge-active {
      background: #1b3a2d !important;
      color: #3fb950 !important;
    }

    .badge-completed {
      background: #1c2333 !important;
      color: #58a6ff !important;
    }

    .badge-expired {
      background: #2a1e0f !important;
      color: #d29922 !important;
    }

    .deployment-card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }

    .deployment-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .deployment-id {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 14px;
      color: #58a6ff;
      font-weight: 600;
    }

    .status-badge {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .status-active {
      background: #1b3a2d;
      color: #3fb950;
    }

    .status-completed {
      background: #1c2333;
      color: #58a6ff;
    }

    .status-expired {
      background: #2a1e0f;
      color: #d29922;
    }

    .deployment-meta {
      font-size: 12px;
      color: #8b949e;
      margin-bottom: 16px;
    }

    .group {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 10px;
    }

    .group:last-child {
      margin-bottom: 0;
    }

    .group-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .group-name {
      font-size: 14px;
      font-weight: 600;
      color: #c9d1d9;
    }

    .group-progress {
      font-size: 12px;
      color: #8b949e;
    }

    .progress-bar {
      width: 100%;
      height: 6px;
      background: #21262d;
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .progress-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.4s ease;
    }

    .progress-bar-fill.complete {
      background: #3fb950;
    }

    .progress-bar-fill.partial {
      background: #d29922;
    }

    .progress-bar-fill.empty {
      background: #484f58;
    }

    .services-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .service-tag {
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 4px;
      font-family: 'SFMono-Regular', Consolas, monospace;
    }

    .service-ready {
      background: #1b3a2d;
      color: #3fb950;
      border: 1px solid #238636;
    }

    .service-pending {
      background: #2a1e0f;
      color: #d29922;
      border: 1px solid #9e6a03;
    }

    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: #484f58;
      font-size: 14px;
    }

    .section {
      margin-bottom: 32px;
    }

    .error-banner {
      background: #3d1a1a;
      border: 1px solid #6e3030;
      color: #f85149;
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 16px;
      font-size: 13px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Deploy <span>Gate</span></h1>
      <div class="refresh-info">Auto-refresh every 5s | <span id="last-update">--</span></div>
    </header>

    <div id="error-banner" class="error-banner"></div>

    <div class="section">
      <div class="section-title">
        Active Deployments
        <span id="active-count" class="badge badge-active">0</span>
      </div>
      <div id="active-deployments">
        <div class="empty-state">No active deployments</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        Recently Completed
        <span id="completed-count" class="badge badge-completed">0</span>
      </div>
      <div id="completed-deployments">
        <div class="empty-state">No recently completed deployments</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        Recently Expired
        <span id="expired-count" class="badge badge-expired">0</span>
      </div>
      <div id="expired-deployments">
        <div class="empty-state">No recently expired deployments</div>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = window.location.origin;

    function esc(str) {
      const d = document.createElement('div');
      d.appendChild(document.createTextNode(str));
      return d.innerHTML;
    }

    function timeAgo(dateStr) {
      const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function renderDeployment(deployment) {
      const groups = deployment.groups;
      const groupNames = Object.keys(groups);

      let groupsHtml = '';
      for (const name of groupNames) {
        const g = groups[name];
        const pct = g.total > 0 ? Math.round((g.ready / g.total) * 100) : 0;
        const fillClass = pct === 100 ? 'complete' : pct > 0 ? 'partial' : 'empty';

        let servicesHtml = '';
        for (const svc of g.services) {
          const cls = svc.ready ? 'service-ready' : 'service-pending';
          const icon = svc.ready ? '&#10003;' : '&#9679;';
          servicesHtml += '<span class="service-tag ' + cls + '">' + icon + ' ' + esc(svc.service_id) + '</span>';
        }

        groupsHtml += '<div class="group">' +
          '<div class="group-header">' +
            '<span class="group-name">' + esc(name) + '</span>' +
            '<span class="group-progress">' + g.ready + ' / ' + g.total + ' ready</span>' +
          '</div>' +
          '<div class="progress-bar"><div class="progress-bar-fill ' + fillClass + '" style="width: ' + pct + '%"></div></div>' +
          '<div class="services-list">' + servicesHtml + '</div>' +
        '</div>';
      }

      const statusClasses = { ACTIVE: 'status-active', COMPLETED: 'status-completed', EXPIRED: 'status-expired' };
      const statusClass = statusClasses[deployment.status] || 'status-completed';
      const endLabel = deployment.status === 'EXPIRED' ? 'Expired' : 'Completed';
      const meta = 'Registered ' + timeAgo(deployment.first_registered_at) +
        (deployment.completed_at ? ' | ' + endLabel + ' ' + timeAgo(deployment.completed_at) : '');

      return '<div class="deployment-card">' +
        '<div class="deployment-header">' +
          '<span class="deployment-id">' + esc(deployment.deployment_id) + '</span>' +
          '<span class="status-badge ' + statusClass + '">' + esc(deployment.status) + '</span>' +
        '</div>' +
        '<div class="deployment-meta">' + meta + '</div>' +
        groupsHtml +
      '</div>';
    }

    async function fetchStatus() {
      try {
        const res = await fetch(API_BASE + '/status');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        const errorBanner = document.getElementById('error-banner');
        errorBanner.style.display = 'none';

        // Active
        const activeContainer = document.getElementById('active-deployments');
        document.getElementById('active-count').textContent = data.active.length;
        if (data.active.length === 0) {
          activeContainer.innerHTML = '<div class="empty-state">No active deployments</div>';
        } else {
          activeContainer.innerHTML = data.active.map(renderDeployment).join('');
        }

        // Completed
        const completedContainer = document.getElementById('completed-deployments');
        document.getElementById('completed-count').textContent = data.recent_completed.length;
        if (data.recent_completed.length === 0) {
          completedContainer.innerHTML = '<div class="empty-state">No recently completed deployments</div>';
        } else {
          completedContainer.innerHTML = data.recent_completed.map(renderDeployment).join('');
        }

        // Expired
        const expiredContainer = document.getElementById('expired-deployments');
        document.getElementById('expired-count').textContent = (data.recent_expired || []).length;
        if (!data.recent_expired || data.recent_expired.length === 0) {
          expiredContainer.innerHTML = '<div class="empty-state">No recently expired deployments</div>';
        } else {
          expiredContainer.innerHTML = data.recent_expired.map(renderDeployment).join('');
        }

        document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
      } catch (err) {
        const errorBanner = document.getElementById('error-banner');
        errorBanner.textContent = 'Failed to fetch status: ' + err.message;
        errorBanner.style.display = 'block';
      }
    }

    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`;

    return reply.type("text/html").send(html);
  });
}
