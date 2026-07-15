const fs = require('fs');
const { exec } = require('child_process');

function generateDashboard(worldData) {
    // Only include categories that have at least one valid, named record
    const validCategories = Object.keys(worldData).filter(cat => 
        worldData[cat].some(item => item.name && item.name.trim() !== "")
    );
    
    let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>DaDAA Dashboard</title>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #1e1e1e; color: #d4d4d4; padding: 20px; }
            .tabs { border-bottom: 2px solid #333; }
            .tab { background: #2d2d2d; color: #888; }
            .tab.active { background: #007acc; color: white; }
            .content-pane { display: none; }
            .content-pane.active { display: block; }
            #filterInput { background: #333; color: white; border: 1px solid #444; }
            details { background: #252526; border: 1px solid #333; }
            pre { background: #121212; color: #ce9178; }
            h1, h2 { color: #ffffff; }
        </style>
    </head>
    <body>
        <h1>World Data Explorer</h1>
        <input type="text" id="filterInput" placeholder="Filter by name..." onkeyup="filterRecords()">
        <div class="tabs">
            ${validCategories.map((cat, i) => `<div class="tab ${i === 0 ? 'active' : ''}" onclick="openTab(event, '${cat}')">${cat.toUpperCase()}</div>`).join('')}
        </div>
    `;

    validCategories.forEach((cat, i) => {
        html += `<div id="${cat}" class="content-pane ${i === 0 ? 'active' : ''}">`;
        worldData[cat].forEach(item => {
            if (!item.name || item.name.trim() === "") return;
            html += `
                <details class="record" data-name="${item.name.toLowerCase()}">
                    <summary>${item.name}</summary>
                    <pre>${JSON.stringify(item, null, 2)}</pre>
                </details>`;
        });
        html += `</div>`;
    });

    html += `
        <script>
            function openTab(evt, tabName) {
                document.querySelectorAll('.content-pane').forEach(p => p.classList.remove('active'));
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.getElementById(tabName).classList.add('active');
                evt.currentTarget.classList.add('active');
            }
            function filterRecords() {
                const query = document.getElementById('filterInput').value.toLowerCase();
                document.querySelectorAll('.record').forEach(rec => {
                    rec.style.display = rec.dataset.name.includes(query) ? 'block' : 'none';
                });
            }
        </script>
    </body></html>`;

    fs.writeFileSync('dashboard.html', html);
    console.log("Dashboard updated! Opening in browser...");

    const startCmd = process.platform === 'win32' ? 'start' : 'open';
    exec(`${startCmd} dashboard.html`);
}

module.exports = { generateDashboard };