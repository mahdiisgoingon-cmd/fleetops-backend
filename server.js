const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Neon PostgreSQL Connection Pool (SSL কনফিগারেশনসহ)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { 
        rejectUnauthorized: false // ক্লাউড Neon ডাটাবেসের জন্য এটি বাধ্যতামূলক
    }
});

// 1. RIDER LOOKUP ENDPOINT (অ্যান্ড্রয়েড অ্যাপের জন্য)
app.get('/api/riders/:iqama', async (req, res) => {
    try {
        const { iqama } = req.params;
        const result = await pool.query('SELECT * FROM riders WHERE iqama_number = $1', [iqama]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Rider not found' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. ASSIGN ASSET / BIKE ENDPOINT (অ্যান্ড্রয়েড অ্যাপ থেকে সাবমিট করলে)
app.post('/api/assets/assign', async (req, res) => {
    const client = await pool.connect();
    try {
        const { admin_name, rider_iqama, item_sku, bike_id, quantity = 1 } = req.body;
        await client.query('BEGIN');

        if (bike_id) {
            // Bike Assign হলে bikes টেবিল আপডেট হবে
            await client.query(
                `UPDATE bikes SET status = 'USING', current_rider_iqama = $1, updated_at = NOW() WHERE bike_id = $2`,
                [rider_iqama, bike_id]
            );
        } else if (item_sku) {
            // Safety gear বা Mobile হলে inventory stock কমবে
            await client.query(
                `UPDATE inventory SET available_stock = available_stock - $1, updated_at = NOW() WHERE sku = $2 AND available_stock >= $1`,
                [quantity, item_sku]
            );
        }

        // Audit Trail-এ লগ এন্ট্রি হবে
        const logResult = await client.query(
            `INSERT INTO audit_trail_logs (admin_name, rider_iqama, item_sku, bike_id, quantity, action_type) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [admin_name, rider_iqama, item_sku || null, bike_id || null, quantity, bike_id ? 'ASSIGN_BIKE' : 'ISSUE_ASSET']
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Asset assigned & logged successfully', log: logResult.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// 3. ADD NEW ASSET / INVENTORY ITEM ENDPOINT (নতুন বাইক বা সেফটি গিয়ার যোগ করার জন্য)
app.post('/api/assets/add', async (req, res) => {
    const client = await pool.connect();
    try {
        const { asset_type, identifier, name, quantity = 1, admin_name = 'Admin' } = req.body;

        await client.query('BEGIN');

        let result;
        if (asset_type === 'BIKE') {
            result = await client.query(
                `INSERT INTO bikes (bike_id, status, created_at, updated_at) 
                 VALUES ($1, 'READY_TO_RIDE', NOW(), NOW()) 
                 ON CONFLICT (bike_id) DO UPDATE SET updated_at = NOW() 
                 RETURNING *`,
                [identifier]
            );
        } else if (asset_type === 'GEAR') {
            result = await client.query(
                `INSERT INTO inventory (sku, name, total_stock, available_stock, updated_at) 
                 VALUES ($1, $2, $3, $3, NOW()) 
                 ON CONFLICT (sku) DO UPDATE SET 
                 total_stock = inventory.total_stock + $3, 
                 available_stock = inventory.available_stock + $3, 
                 updated_at = NOW() 
                 RETURNING *`,
                [identifier, name || identifier, quantity]
            );
        } else {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Invalid asset_type. Must be BIKE or GEAR.' });
        }

        await client.query(
            `INSERT INTO audit_trail_logs (admin_name, item_sku, bike_id, quantity, action_type) 
             VALUES ($1, $2, $3, $4, $5)`,
            [admin_name, asset_type === 'GEAR' ? identifier : null, asset_type === 'BIKE' ? identifier : null, quantity, 'ADD_NEW_ASSET']
        );

        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            message: `${asset_type} added/restocked successfully`,
            data: result.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// 4. SUPER ADMIN DASHBOARD SUMMARY ENDPOINT (এপিআই এর জন্য)
app.get('/api/dashboard/summary', async (req, res) => {
    try {
        const bikesSummary = await pool.query('SELECT status, COUNT(*) FROM bikes GROUP BY status');
        const inventoryStock = await pool.query('SELECT * FROM inventory');
        const recentLogs = await pool.query('SELECT * FROM audit_trail_logs ORDER BY timestamp DESC LIMIT 50');

        res.json({
            success: true,
            bikes_status: bikesSummary.rows,
            inventory: inventoryStock.rows,
            audit_logs: recentLogs.rows
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. BUILT-IN HTML SUPER ADMIN DASHBOARD ROUTE (সরাসরি ভিজ্যুয়াল ড্যাশবোর্ড দেখার জন্য)
app.get('/dashboard', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>FleetOps Super Admin Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 font-sans p-6">
        <div class="max-w-7xl mx-auto">
            <header class="mb-8 flex justify-between items-center">
                <div>
                    <h1 class="text-3xl font-bold text-gray-800">FleetOps Super Admin Dashboard</h1>
                    <p class="text-gray-600">Real-time monitoring of bikes, inventory, and audit logs</p>
                </div>
                <button onclick="fetchDashboardData()" class="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 shadow">
                    🔄 Refresh Data
                </button>
            </header>

            <!-- 1. Bikes Status Cards -->
            <div id="bikes-cards" class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div class="bg-white p-6 rounded-xl shadow border-l-4 border-blue-500">Loading Bikes...</div>
            </div>

            <!-- 2. Inventory Section -->
            <div class="bg-white rounded-xl shadow p-6 mb-8">
                <h2 class="text-xl font-bold text-gray-800 mb-4">Inventory & Safety Gear Stock</h2>
                <div id="inventory-grid" class="grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div class="p-4 bg-gray-50 rounded">Loading Inventory...</div>
                </div>
            </div>

            <!-- 3. Audit Logs Table -->
            <div class="bg-white rounded-xl shadow p-6">
                <h2 class="text-xl font-bold text-gray-800 mb-4">Recent Audit Trail Logs</h2>
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="border-b bg-gray-50 text-gray-600 text-sm">
                                <th class="p-3">Action</th>
                                <th class="p-3">Admin</th>
                                <th class="p-3">Rider Iqama</th>
                                <th class="p-3">Bike / SKU</th>
                                <th class="p-3">Time</th>
                            </tr>
                        </thead>
                        <tbody id="audit-table-body">
                            <tr><td colspan="5" class="p-4 text-center">Loading Logs...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            async function fetchDashboardData() {
                try {
                    const res = await fetch('/api/dashboard/summary');
                    const data = await res.json();
                    if (!data.success) return;

                    // Render Bike Status
                    const bikesDiv = document.getElementById('bikes-cards');
                    bikesDiv.innerHTML = data.bikes_status.map(b => \`
                        <div class="bg-white p-6 rounded-xl shadow border-l-4 border-blue-500">
                            <h3 class="text-gray-500 text-sm font-semibold uppercase">\${b.status}</h3>
                            <p class="text-3xl font-bold text-gray-800 mt-2">\${b.count}</p>
                        </div>
                    \`).join('') || '<p class="text-gray-500">No bike data found.</p>';

                    // Render Inventory
                    const invDiv = document.getElementById('inventory-grid');
                    invDiv.innerHTML = data.inventory.map(i => \`
                        <div class="bg-gray-50 p-4 rounded-lg border border-gray-200">
                            <h4 class="font-semibold text-gray-700">\${i.name}</h4>
                            <p class="text-sm text-gray-500 mt-1">Available: <span class="font-bold text-green-600">\${i.available_stock}</span> / \${i.total_stock}</p>
                        </div>
                    \`).join('') || '<p class="text-gray-500">No inventory found.</p>';

                    // Render Audit Logs
                    const tableBody = document.getElementById('audit-table-body');
                    tableBody.innerHTML = data.audit_logs.map(log => \`
                        <tr class="border-b hover:bg-gray-50 text-sm">
                            <td class="p-3 font-medium text-blue-600">\${log.action_type}</td>
                            <td class="p-3">\${log.admin_name}</td>
                            <td class="p-3">\${log.rider_iqama || 'N/A'}</td>
                            <td class="p-3">\${log.bike_id || log.item_sku || 'N/A'}</td>
                            <td class="p-3 text-gray-500">\${new Date(log.timestamp).toLocaleString()}</td>
                        </tr>
                    \`).join('');
                } catch (err) {
                    console.error('Error fetching data:', err);
                }
            }

            fetchDashboardData();
        </script>
    </body>
    </html>
    `);
});

const PORT = process.env.PORT || 5000;
app.listen(