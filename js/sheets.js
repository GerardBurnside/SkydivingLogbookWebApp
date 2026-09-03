// Google Sheets API v4 Integration via OAuth (replaces Apps Script proxy)
// Requires js/auth.js (AuthManager) to be loaded first.

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

class SheetsAPI {
    constructor() {
        this.spreadsheetId = '';
        this.initialized = false;
        this._pollTimer = null;
        this._syncInProgress = false;
        this._syncConflictPending = false;
        this._pendingConflict = null;
        this._todoSheetsReady = false;

        this.ready = this.setupAPI();
    }

    // ── Initialisation ──────────────────────────────────────────────────

    async setupAPI() {
        try {
            // Load OAuth-based spreadsheet ID
            this.spreadsheetId = localStorage.getItem('oauth-spreadsheet-id') || '';

            await window.AuthManager.ready;

            if (this.spreadsheetId && window.AuthManager.isSignedIn()) {
                this.initialized = true;
                console.log('[Sheets] OAuth API initialised, spreadsheet:', this.spreadsheetId);
                this.updateSyncStatus('Ready');
            } else if (this.spreadsheetId) {
                // Have a sheet but no active token — will try silent refresh on sync
                this.initialized = true;
                console.log('[Sheets] Spreadsheet configured, token will refresh on sync');
                this.updateSyncStatus('Ready');
            } else {
                console.log('[Sheets] Not configured — sign in to enable sync');
                this.updateSyncStatus('Not signed in');
            }
        } catch (error) {
            console.error('[Sheets] Setup failed:', error);
            this.updateSyncStatus('Configuration error');
        }
    }

    /** Re-initialise after OAuth sign-in or spreadsheet creation. */
    reinitialize(spreadsheetId) {
        this.spreadsheetId = spreadsheetId || '';
        if (spreadsheetId) {
            localStorage.setItem('oauth-spreadsheet-id', spreadsheetId);
        }
        this._todoSheetsReady = false;

        if (this.spreadsheetId) {
            this.initialized = true;
            console.log('[Sheets] Re-initialised with spreadsheet:', this.spreadsheetId);
            this.updateSyncStatus('Ready');
        } else {
            this.initialized = false;
            this.updateSyncStatus('Not signed in');
        }
    }

    /** Generate a unique jump ID (stable across renumbers). */
    static generateJumpId() {
        return typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : 'jump-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }

    /**
     * Persistent device/browser identifier for sync. When the sheet's last write
     * was from this device, we can safely push only (no pull), avoiding data loss.
     */
    getDeviceId() {
        const key = 'skydiving-device-id';
        let id = localStorage.getItem(key);
        if (!id) {
            id = typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : 'browser-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
            localStorage.setItem(key, id);
        }
        return id;
    }

    // ── Sheets API v4 transport layer ───────────────────────────────────

    /**
     * Make an authenticated request to the Google Sheets API v4.
     * Handles token refresh and 401 retry automatically.
     */
    async _apiCall(method, path, body = null, retry = true) {
        const token = await window.AuthManager.getValidToken();
        const url = `${SHEETS_API}/${this.spreadsheetId}${path}`;

        const opts = {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        };
        if (body !== null) {
            opts.body = JSON.stringify(body);
        }

        const resp = await fetch(url, opts);

        if (resp.status === 401 && retry) {
            // Token was rejected — force refresh and retry once
            console.warn('[Sheets] 401 — refreshing token and retrying');
            await window.AuthManager.silentRefresh();
            return this._apiCall(method, path, body, false);
        }

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Sheets API ${resp.status}: ${text}`);
        }

        // Some calls (e.g. clear) may return empty body
        const ct = resp.headers.get('content-type') || '';
        return ct.includes('application/json') ? resp.json() : {};
    }

    // ── Spreadsheet discovery & creation ─────────────────────────────────

    /**
     * Search the user's Drive for an existing Swooper Logbook spreadsheet
     * created by this app (drive.file scope). Returns the spreadsheetId or null.
     */
    async findExistingSpreadsheet() {
        const token = await window.AuthManager.getValidToken();
        const query = "name contains 'Swooper Logbook' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id,name)')}&orderBy=createdTime`;

        const resp = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!resp.ok) {
            console.warn('[Sheets] Drive search failed:', resp.status);
            return null;
        }

        const data = await resp.json();
        if (data.files && data.files.length > 0) {
            console.log('[Sheets] Found existing spreadsheet:', data.files[0].id, data.files[0].name);
            return data.files[0].id;
        }
        return null;
    }

    /**
     * Find an existing Swooper Logbook spreadsheet, or create a new one.
     * Returns the spreadsheetId.
     */
    async findOrCreateSpreadsheet() {
        const existingId = await this.findExistingSpreadsheet();
        if (existingId) {
            localStorage.setItem('oauth-spreadsheet-id', existingId);
            this.spreadsheetId = existingId;
            this.initialized = true;
            return existingId;
        }
        return this.createSpreadsheet();
    }

    /**
     * Create a new spreadsheet in the user's Drive with the required structure.
     * Returns the new spreadsheetId.
     */
    async createSpreadsheet() {
        const token = await window.AuthManager.getValidToken();
        const email = window.AuthManager.userEmail || 'User';

        const body = {
            properties: { title: `Swooper Logbook — ${email}` },
            sheets: [
                {
                    properties: { title: 'Jumps', index: 0 },
                    data: [{
                        startRow: 0, startColumn: 0,
                        rowData: [{
                            values: [
                                'Jump ID', 'Jump Number', 'Date', 'Location', 'Equipment',
                                'Notes', 'Timestamp', 'Equipment ID', 'Lineset Number', 'Harness ID'
                            ].map(v => ({ userEnteredValue: { stringValue: v } }))
                        }]
                    }]
                },
                {
                    properties: { title: 'deletedJumps', index: 1 },
                    data: [{
                        startRow: 0, startColumn: 0,
                        rowData: [{
                            values: [
                                { userEnteredValue: { stringValue: 'Jump ID' } },
                                { userEnteredValue: { stringValue: 'Date deleted' } }
                            ]
                        }]
                    }]
                },
                {
                    properties: { title: 'Equipment', index: 2 },
                    data: [{
                        startRow: 0, startColumn: 0,
                        rowData: [
                            { values: [{ userEnteredValue: { stringValue: 'harnesses' } }, { userEnteredValue: { stringValue: '[]' } }] },
                            { values: [{ userEnteredValue: { stringValue: 'canopies' } },  { userEnteredValue: { stringValue: '[]' } }] },
                            { values: [{ userEnteredValue: { stringValue: 'rigs' } },      { userEnteredValue: { stringValue: '[]' } }] },
                            { values: [{ userEnteredValue: { stringValue: 'settings' } },  { userEnteredValue: { stringValue: '{}' } }] },
                            { values: [{ userEnteredValue: { stringValue: 'locations' } }, { userEnteredValue: { stringValue: '[]' } }] },
                            { values: [{ userEnteredValue: { stringValue: '_syncMeta' } }, { userEnteredValue: { stringValue: '{}' } }] },
                        ]
                    }]
                },
                {
                    properties: { title: 'Todos', index: 3 },
                    data: [{
                        startRow: 0, startColumn: 0,
                        rowData: [{
                            values: [
                                'ID', 'Text', 'Done', 'Created At', 'Done At', 'Updated At'
                            ].map(v => ({ userEnteredValue: { stringValue: v } }))
                        }]
                    }]
                },
                {
                    properties: { title: 'deletedTodos', index: 4 },
                    data: [{
                        startRow: 0, startColumn: 0,
                        rowData: [{
                            values: [
                                { userEnteredValue: { stringValue: 'ID' } },
                                { userEnteredValue: { stringValue: 'Date deleted' } }
                            ]
                        }]
                    }]
                }
            ]
        };

        const resp = await fetch(SHEETS_API, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Create spreadsheet failed ${resp.status}: ${text}`);
        }

        const result = await resp.json();
        const newId = result.spreadsheetId;

        localStorage.setItem('oauth-spreadsheet-id', newId);
        this.spreadsheetId = newId;
        this.initialized = true;

        console.log('[Sheets] Created spreadsheet:', newId);
        return newId;
    }

    // ── Read operations (Sheets API v4) ─────────────────────────────────

    async getAllJumps() {
        if (!this.initialized) throw new Error('API not initialized');

        const result = await this._apiCall(
            'GET',
            '/values/Jumps!A2:J?majorDimension=ROWS'
        );

        const rows = result.values || [];
        if (rows.length === 0) return [];

        return rows.map((row, index) => {
            const hasJumpIdColumn = row && row.length >= 9;
            if (hasJumpIdColumn) {
                const jumpId = (row[0] && String(row[0]).trim()) || SheetsAPI.generateJumpId();
                const timestamp = row[6] || new Date().toISOString();
                const parsedTime = new Date(timestamp).getTime();
                // IndexedDB keyPath is `id`. Many imports share the same timestamp (e.g. noon UTC per day);
                // identical ids would overwrite each other in replaceAllJumps — include row index so ids are unique.
                const id = Number.isFinite(parsedTime) ? parsedTime + index : Date.now() + index;
                const equipment = (row[7] && row[7] !== '') ? row[7] : row[4] || '';
                let date = '';
                if (row[2]) {
                    const s = String(row[2]);
                    if (/^\d{4}-\d{2}-\d{2}/.test(s)) date = s.slice(0, 10);
                    else { const d = new Date(s); date = isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10); }
                }
                return {
                    id,
                    jumpId,
                    jumpNumber: parseInt(row[1]) || 0,
                    date,
                    location: row[3] || '',
                    equipment,
                    linesetNumber: parseInt(row[8]) || 1,
                    notes: row[5] || '',
                    timestamp,
                    ...(row.length >= 10 && String(row[9] ?? '').trim()
                        ? { harnessId: String(row[9]).trim() }
                        : {})
                };
            }
            // Backward compat: 8 columns (no Jump ID)
            const timestamp = row[5] || new Date().toISOString();
            const parsedTime = new Date(timestamp).getTime();
            const id = Number.isFinite(parsedTime) ? parsedTime + index : Date.now() + index;
            const equipment = (row[6] && row[6] !== '') ? row[6] : row[3] || '';
            let date = '';
            if (row[1]) {
                const s = String(row[1]);
                if (/^\d{4}-\d{2}-\d{2}/.test(s)) date = s.slice(0, 10);
                else { const d = new Date(s); date = isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10); }
            }
            return {
                id,
                jumpId: SheetsAPI.generateJumpId(),
                jumpNumber: parseInt(row[0]) || 0,
                date,
                location: row[2] || '',
                equipment,
                linesetNumber: parseInt(row[7]) || 1,
                notes: row[4] || '',
                timestamp
            };
        });
    }

    /** Read the Equipment sheet (6 key-value rows). Returns a parsed object. */
    async _getEquipment() {
        const result = await this._apiCall(
            'GET',
            '/values/Equipment!A1:B6?majorDimension=ROWS'
        );

        const rows = result.values || [];
        const data = {};
        for (const row of rows) {
            const key = (row[0] || '').trim();
            if (!key) continue;
            try { data[key] = JSON.parse(row[1] || '{}'); }
            catch { data[key] = row[1]; }
        }
        return data;
    }

    /** Ensure deletedJumps sheet exists (for existing spreadsheets created before this feature). */
    async _ensureDeletedJumpsSheet() {
        const meta = await this._apiCall('GET', '?fields=sheets(properties(title,sheetId))');
        const hasDeletedJumps = (meta.sheets || []).some(s => (s.properties && s.properties.title) === 'deletedJumps');
        if (hasDeletedJumps) return;
        // AddSheetRequest only accepts properties, not data; writing header is done separately.
        await this._apiCall('POST', ':batchUpdate', {
            requests: [{ addSheet: { properties: { title: 'deletedJumps' } } }]
        });
        await this._apiCall('PUT', '/values/deletedJumps!A1:B1?valueInputOption=RAW', {
            values: [['Jump ID', 'Date deleted']]
        });
        console.log('[Sheets] Added deletedJumps sheet');
    }

    /** Read deletedJumps sheet and return a Set of jump IDs. */
    async getDeletedJumpIds() {
        try {
            const result = await this._apiCall('GET', '/values/deletedJumps!A2:A?majorDimension=ROWS');
            const rows = result.values || [];
            const ids = new Set();
            for (const row of rows) {
                const id = (row[0] && String(row[0]).trim()) || '';
                if (id) ids.add(id);
            }
            return ids;
        } catch (e) {
            if (e.message && e.message.includes('404')) return new Set();
            const meta = await this._apiCall('GET', '?fields=sheets(properties(title))');
            const hasSheet = (meta.sheets || []).some(s => (s.properties && s.properties.title) === 'deletedJumps');
            if (!hasSheet) return new Set();
            throw e;
        }
    }

    /** Append rows to deletedJumps sheet (one row per jumpId). Call _ensureDeletedJumpsSheet first if needed. */
    async appendDeletedJumps(jumpIds) {
        if (!jumpIds || jumpIds.length === 0) return;
        await this._ensureDeletedJumpsSheet();
        const now = new Date().toISOString();
        const rows = [...jumpIds].map(id => [id, now]);
        const result = await this._apiCall('GET', '/values/deletedJumps?majorDimension=ROWS');
        const existing = (result.values || []).length;
        const startRow = existing + 1;
        const endRow = existing + rows.length;
        const range = `deletedJumps!A${startRow}:B${endRow}`;
        await this._apiCall('PUT', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values: rows });
        console.log('[Sheets] Appended', jumpIds.length, 'deletion(s) to deletedJumps');
    }

    // ── TODOs sheet ─────────────────────────────────────────────────────

    static todoUpdatedAt(todo) {
        const n = Number(todo?.updatedAt);
        if (Number.isFinite(n) && n > 0) return n;
        const doneAt = Number(todo?.doneAt);
        if (todo?.done && Number.isFinite(doneAt) && doneAt > 0) return doneAt;
        const created = Number(todo?.createdAt);
        return Number.isFinite(created) && created > 0 ? created : 0;
    }

    static _todoId(todo) {
        return todo && String(todo.id || '').trim();
    }

    /**
     * Merge local and sheet TODOs. Deleted IDs win (item is removed even if
     * it still exists on the other side). Same-id edits use last-write-wins.
     */
    static mergeTodos(localTodos, sheetTodos, deletedTodoIds) {
        const deletedSet = deletedTodoIds instanceof Set
            ? deletedTodoIds
            : new Set(deletedTodoIds || []);
        const localList = Array.isArray(localTodos) ? localTodos : [];
        const sheetList = Array.isArray(sheetTodos) ? sheetTodos : [];
        const byId = new Map();

        const consider = (todo, localWinsTie) => {
            const id = SheetsAPI._todoId(todo);
            if (!id || deletedSet.has(id)) return;
            const incoming = { ...todo, id };
            const existing = byId.get(id);
            if (!existing) {
                byId.set(id, incoming);
                return;
            }
            const existingTs = SheetsAPI.todoUpdatedAt(existing);
            const incomingTs = SheetsAPI.todoUpdatedAt(incoming);
            if (incomingTs > existingTs || (incomingTs === existingTs && localWinsTie)) {
                byId.set(id, incoming);
            }
        };

        for (const t of sheetList) consider(t, false);
        for (const t of localList) consider(t, true);

        const seen = new Set();
        const merged = [];
        const appendFrom = (list) => {
            for (const t of list) {
                const id = SheetsAPI._todoId(t);
                if (!id || seen.has(id) || !byId.has(id)) continue;
                merged.push(byId.get(id));
                seen.add(id);
            }
        };
        appendFrom(localList);
        appendFrom(sheetList);
        return merged;
    }

    static mergeDeletedTodos(localDeleted, sheetDeleted) {
        const byId = new Map();
        const add = (record) => {
            const id = record && String(record.id || '').trim();
            if (!id) return;
            const deletedAt = record.deletedAt || new Date().toISOString();
            const existing = byId.get(id);
            if (!existing) {
                byId.set(id, { id, deletedAt });
                return;
            }
            if (String(deletedAt) < String(existing.deletedAt || '')) {
                byId.set(id, { id, deletedAt });
            }
        };
        for (const d of localDeleted || []) add(d);
        for (const d of sheetDeleted || []) add(typeof d === 'string' ? { id: d } : d);
        return Array.from(byId.values());
    }

    static todosEqual(a, b) {
        const mapA = new Map((a || []).filter(t => SheetsAPI._todoId(t)).map(t => [SheetsAPI._todoId(t), t]));
        const mapB = new Map((b || []).filter(t => SheetsAPI._todoId(t)).map(t => [SheetsAPI._todoId(t), t]));
        if (mapA.size !== mapB.size) return false;
        for (const [id, ta] of mapA) {
            const tb = mapB.get(id);
            if (!tb) return false;
            if (String(ta.text || '') !== String(tb.text || '')) return false;
            if (Boolean(ta.done) !== Boolean(tb.done)) return false;
            if (SheetsAPI.todoUpdatedAt(ta) !== SheetsAPI.todoUpdatedAt(tb)) return false;
        }
        return true;
    }

    _parseTodoTimestamp(value) {
        if (value === '' || value == null) return 0;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 1e12 ? value : (value > 1e9 ? value * 1000 : value);
        }
        const asNum = Number(value);
        if (Number.isFinite(asNum) && String(value).trim() !== '' && !String(value).includes('-') && !String(value).includes('T')) {
            return asNum > 1e12 ? asNum : (asNum > 1e9 ? asNum * 1000 : asNum);
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    _parseTodoDone(value) {
        if (value === true || value === 1) return true;
        const s = String(value == null ? '' : value).trim().toLowerCase();
        return s === 'true' || s === 'yes' || s === '1';
    }

    _formatTodoTimestamp(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return '';
        try {
            return new Date(n).toISOString();
        } catch {
            return '';
        }
    }

    async _ensureTodosSheets() {
        if (this._todoSheetsReady) return;
        const meta = await this._apiCall('GET', '?fields=sheets(properties(title))');
        const titles = new Set((meta.sheets || []).map(s => s.properties && s.properties.title).filter(Boolean));
        const requests = [];
        if (!titles.has('Todos')) {
            requests.push({ addSheet: { properties: { title: 'Todos' } } });
        }
        if (!titles.has('deletedTodos')) {
            requests.push({ addSheet: { properties: { title: 'deletedTodos' } } });
        }
        if (requests.length) {
            await this._apiCall('POST', ':batchUpdate', { requests });
        }
        if (!titles.has('Todos')) {
            await this._apiCall('PUT', '/values/Todos!A1:F1?valueInputOption=RAW', {
                values: [['ID', 'Text', 'Done', 'Created At', 'Done At', 'Updated At']]
            });
            console.log('[Sheets] Added Todos sheet');
        }
        if (!titles.has('deletedTodos')) {
            await this._apiCall('PUT', '/values/deletedTodos!A1:B1?valueInputOption=RAW', {
                values: [['ID', 'Date deleted']]
            });
            console.log('[Sheets] Added deletedTodos sheet');
        }
        this._todoSheetsReady = true;
    }

    async getAllTodos() {
        try {
            const result = await this._apiCall('GET', '/values/Todos!A2:F?majorDimension=ROWS');
            const rows = result.values || [];
            const todos = [];
            for (const row of rows) {
                const id = (row[0] && String(row[0]).trim()) || '';
                if (!id) continue;
                const createdAt = this._parseTodoTimestamp(row[3]) || Date.now();
                const done = this._parseTodoDone(row[2]);
                const doneAt = done ? (this._parseTodoTimestamp(row[4]) || createdAt) : null;
                const updatedAt = this._parseTodoTimestamp(row[5]) || doneAt || createdAt;
                todos.push({
                    id,
                    text: row[1] != null ? String(row[1]) : '',
                    done,
                    createdAt,
                    doneAt,
                    updatedAt
                });
            }
            return todos;
        } catch (e) {
            if (e.message && e.message.includes('404')) return [];
            const meta = await this._apiCall('GET', '?fields=sheets(properties(title))');
            const hasSheet = (meta.sheets || []).some(s => (s.properties && s.properties.title) === 'Todos');
            if (!hasSheet) return [];
            throw e;
        }
    }

    async getDeletedTodos() {
        try {
            const result = await this._apiCall('GET', '/values/deletedTodos!A2:B?majorDimension=ROWS');
            const rows = result.values || [];
            const records = [];
            const seen = new Set();
            for (const row of rows) {
                const id = (row[0] && String(row[0]).trim()) || '';
                if (!id || seen.has(id)) continue;
                seen.add(id);
                records.push({
                    id,
                    deletedAt: (row[1] && String(row[1]).trim()) || new Date().toISOString()
                });
            }
            return records;
        } catch (e) {
            if (e.message && e.message.includes('404')) return [];
            const meta = await this._apiCall('GET', '?fields=sheets(properties(title))');
            const hasSheet = (meta.sheets || []).some(s => (s.properties && s.properties.title) === 'deletedTodos');
            if (!hasSheet) return [];
            throw e;
        }
    }

    async appendDeletedTodos(todoIds, records) {
        if (!todoIds || todoIds.length === 0) return;
        await this._ensureTodosSheets();
        const byId = new Map((records || []).map(r => [r.id, r]));
        const now = new Date().toISOString();
        const rows = [...todoIds].map(id => [
            id,
            (byId.get(id) && byId.get(id).deletedAt) || now
        ]);
        const result = await this._apiCall('GET', '/values/deletedTodos?majorDimension=ROWS');
        const existing = (result.values || []).length;
        const startRow = existing + 1;
        const endRow = existing + rows.length;
        const range = `deletedTodos!A${startRow}:B${endRow}`;
        await this._apiCall('PUT', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values: rows });
        console.log('[Sheets] Appended', todoIds.length, 'deletion(s) to deletedTodos');
    }

    async uploadAllTodos(todos) {
        if (!this.initialized) throw new Error('API not initialized');
        await this._ensureTodosSheets();
        const header = ['ID', 'Text', 'Done', 'Created At', 'Done At', 'Updated At'];
        const dataRows = (todos || []).map(todo => {
            const id = SheetsAPI._todoId(todo) || SheetsAPI.generateJumpId();
            if (!todo.id) todo.id = id;
            return [
                id,
                todo.text || '',
                todo.done ? 'TRUE' : 'FALSE',
                this._formatTodoTimestamp(todo.createdAt),
                todo.done ? this._formatTodoTimestamp(todo.doneAt) : '',
                this._formatTodoTimestamp(todo.updatedAt || SheetsAPI.todoUpdatedAt(todo))
            ];
        });
        await this._apiCall('POST', '/values/Todos!A1:F:clear', {});
        await this._apiCall('PUT', '/values/Todos!A1:F?valueInputOption=RAW', {
            values: [header, ...dataRows]
        });
        console.log(`[Sheets] Uploaded ${dataRows.length} todo(s)`);
    }

    _readLocalTodos() {
        const logbook = window.logbook;
        if (logbook) {
            return {
                todos: Array.isArray(logbook.todos) ? [...logbook.todos] : [],
                deleted: Array.isArray(logbook.deletedTodos) ? [...logbook.deletedTodos] : []
            };
        }
        let todos = [];
        let deleted = [];
        try {
            const parsed = JSON.parse(localStorage.getItem('skydiving-todos') || '[]');
            if (Array.isArray(parsed)) todos = parsed;
        } catch (_) { /* ignore */ }
        try {
            const parsed = JSON.parse(localStorage.getItem('skydiving-deleted-todos') || '[]');
            if (Array.isArray(parsed)) deleted = parsed;
        } catch (_) { /* ignore */ }
        return { todos, deleted };
    }

    _applyTodosLocally(mergedTodos, mergedDeleted) {
        try {
            localStorage.setItem('skydiving-todos', JSON.stringify(mergedTodos || []));
            localStorage.setItem('skydiving-deleted-todos', JSON.stringify(mergedDeleted || []));
        } catch (err) {
            console.error('[Sync] Failed to save todos locally:', err);
        }
        const logbook = window.logbook;
        if (logbook && typeof logbook.applyTodosFromSync === 'function') {
            logbook.applyTodosFromSync(mergedTodos, mergedDeleted);
        }
    }

    /**
     * Pull TODOs from the sheet, merge with local (honouring deletion tombstones),
     * write the result back to the sheet when needed, and apply locally.
     * @returns {{ changed: boolean }}
     */
    async syncTodosWithSheet() {
        if (!this.initialized) return { changed: false };
        await this._ensureTodosSheets();

        const local = this._readLocalTodos();
        const sheetTodos = await this.getAllTodos();
        const sheetDeleted = await this.getDeletedTodos();
        const mergedDeleted = SheetsAPI.mergeDeletedTodos(local.deleted, sheetDeleted);
        const deletedIds = new Set(mergedDeleted.map(d => d.id));
        const mergedTodos = SheetsAPI.mergeTodos(local.todos, sheetTodos, deletedIds);

        this._applyTodosLocally(mergedTodos, mergedDeleted);

        const sheetDeletedIds = new Set(sheetDeleted.map(d => d.id));
        const newDeletionIds = mergedDeleted.map(d => d.id).filter(id => !sheetDeletedIds.has(id));
        const survivingSheetTodos = sheetTodos.filter(t => t.id && !deletedIds.has(t.id));
        const todosChanged = !SheetsAPI.todosEqual(mergedTodos, survivingSheetTodos);

        if (todosChanged) {
            await this.uploadAllTodos(mergedTodos);
        }
        if (newDeletionIds.length) {
            await this.appendDeletedTodos(newDeletionIds, mergedDeleted);
        }

        const changed = todosChanged || newDeletionIds.length > 0;
        if (changed) {
            console.log('[Sync] Todos merged:', mergedTodos.length, 'item(s),', mergedDeleted.length, 'deleted');
        }
        return { changed };
    }

    async syncTodosWithSheetSafe() {
        try {
            return await this.syncTodosWithSheet();
        } catch (error) {
            console.error('[Sync] Todos sync failed:', error);
            return { changed: false };
        }
    }

    async _touchSyncMetaForTodos() {
        const newTs = new Date().toISOString();
        await this.syncEquipmentToSheet(newTs);
        localStorage.setItem('skydiving-data-synced', newTs);
        localStorage.setItem('skydiving-data-modified', newTs);
    }

    async _syncTodosAndTouchMetaIfChanged() {
        const todoResult = await this.syncTodosWithSheetSafe();
        if (todoResult.changed) {
            await this._touchSyncMetaForTodos();
        }
        return todoResult;
    }

    // ── Write operations (Sheets API v4) ────────────────────────────────

    async uploadAllJumps(jumps) {
        if (!this.initialized) throw new Error('API not initialized');
        this.updateSyncStatus('Uploading data...');

        const header = ['Jump ID', 'Jump Number', 'Date', 'Location', 'Equipment', 'Notes', 'Timestamp', 'Equipment ID', 'Lineset Number', 'Harness ID'];
        const sortedJumps = [...jumps].sort((a, b) => (a.jumpNumber || 0) - (b.jumpNumber || 0));

        const dataRows = sortedJumps.map(jump => {
            const jumpId = jump.jumpId || SheetsAPI.generateJumpId();
            if (!jump.jumpId) jump.jumpId = jumpId;
            let equipmentName = jump.equipment;
            if (window.logbook) {
                const canopy = window.logbook.canopies.find(c => c.id === jump.equipment);
                if (canopy) {
                    const ls = canopy.linesets?.find(l => l.number === jump.linesetNumber);
                    const hybridSuffix = ls?.hybrid ? ' (Hybrid)' : '';
                    equipmentName = `${canopy.name}-Lineset#${jump.linesetNumber || 1}${hybridSuffix}`;
                }
            }
            return [
                jumpId,
                jump.jumpNumber,
                jump.date,
                jump.location,
                equipmentName,
                jump.notes || '',
                jump.timestamp,
                jump.equipment,
                jump.linesetNumber || 1,
                (jump.harnessId != null && String(jump.harnessId).trim()) ? String(jump.harnessId).trim() : ''
            ];
        });

        await this._apiCall('POST', '/values/Jumps!A1:J:clear', {});
        await this._apiCall('PUT', '/values/Jumps!A1:J?valueInputOption=RAW', {
            values: [header, ...dataRows]
        });

        console.log(`[Sheets] Uploaded ${jumps.length} jumps`);
    }

    async syncEquipmentToSheet(dataModified = null) {
        if (!this.initialized) return;
        if (!window.AuthManager.isSignedIn()) {
            this.updateSyncStatus('Unsynced');
            return;
        }

        const logbook = window.logbook;
        if (!logbook) return;

        const rows = [
            ['harnesses',  JSON.stringify(logbook.harnesses || [])],
            ['canopies',   JSON.stringify(logbook.canopies || [])],
            ['rigs',       JSON.stringify([])],
            ['settings',   JSON.stringify(logbook.settings || {})],
            ['locations',  JSON.stringify(logbook.locations || [])],
            ['_syncMeta',  JSON.stringify(dataModified ? { dataModified, deviceId: this.getDeviceId() } : {})],
        ];

        try {
            await this._apiCall('PUT', '/values/Equipment!A1:B6?valueInputOption=RAW', {
                values: rows
            });
            console.log('[Sheets] Equipment synced');
        } catch (error) {
            console.error('[Sheets] Equipment sync failed:', error);
        }
    }

    /** True when sheet and local both changed since last sync (another device wrote the sheet). */
    _hasSyncConflict(d, localSynced, localModified) {
        const sheetTs = (d._syncMeta && d._syncMeta.dataModified) || '';
        const sheetDeviceId = (d._syncMeta && d._syncMeta.deviceId) || null;
        const hasSheetData = !!(d.harnesses || d.canopies);
        const sheetIsNewer = (sheetTs && sheetTs > localSynced) ||
                             (hasSheetData && !localSynced && !sheetTs);
        const hasPending = !!(localModified && localModified > localSynced);
        const lastWriteFromThisDevice = sheetDeviceId && sheetDeviceId === this.getDeviceId();
        return sheetIsNewer && hasPending && !lastWriteFromThisDevice;
    }

    _contentEqualJson(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    }

    _mergeEquipmentList(localList, sheetList) {
        const byId = new Map((sheetList || []).filter(x => x?.id).map(x => [x.id, x]));
        for (const item of localList || []) {
            if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
        }
        return Array.from(byId.values());
    }

    /**
     * Build per-equipment conflict items (harnesses, canopies, locations, settings).
     */
    computeEquipmentConflictItems(localEquipment, sheetEquipment) {
        const items = [];
        const kinds = [
            { key: 'harnesses', label: 'Harness', equipmentKind: 'harness' },
            { key: 'canopies', label: 'Canopy', equipmentKind: 'canopy' },
            { key: 'locations', label: 'Location', equipmentKind: 'location' }
        ];

        for (const { key, label, equipmentKind } of kinds) {
            const localList = localEquipment?.[key] || [];
            const sheetList = sheetEquipment?.[key] || [];
            const localById = new Map(localList.filter(x => x?.id).map(x => [x.id, x]));
            const sheetById = new Map(sheetList.filter(x => x?.id).map(x => [x.id, x]));
            const matchedLocal = new Set();
            const matchedSheet = new Set();

            for (const [entityId, local] of localById) {
                const sheet = sheetById.get(entityId);
                if (!sheet) continue;
                matchedLocal.add(entityId);
                matchedSheet.add(entityId);
                if (!this._contentEqualJson(local, sheet)) {
                    items.push({
                        id: `${equipmentKind}:${entityId}`,
                        entityId,
                        equipmentKind,
                        type: 'modified',
                        local,
                        sheet,
                        title: `${label} "${local.name || sheet.name || entityId}" — edited on both sides`
                    });
                }
            }

            for (const [entityId, local] of localById) {
                if (matchedLocal.has(entityId)) continue;
                items.push({
                    id: `local:${equipmentKind}:${entityId}`,
                    entityId,
                    equipmentKind,
                    type: 'local_only',
                    local,
                    title: `${label} "${local.name || entityId}" — only on this device`
                });
            }

            for (const [entityId, sheet] of sheetById) {
                if (matchedSheet.has(entityId)) continue;
                items.push({
                    id: `sheet:${equipmentKind}:${entityId}`,
                    entityId,
                    equipmentKind,
                    type: 'sheet_only',
                    sheet,
                    title: `${label} "${sheet.name || entityId}" — only on sheet`
                });
            }
        }

        const localSettings = localEquipment?.settings || {};
        const sheetSettings = sheetEquipment?.settings || {};
        if (!this._contentEqualJson(localSettings, sheetSettings)) {
            items.push({
                id: 'settings',
                equipmentKind: 'settings',
                type: 'modified',
                local: localSettings,
                sheet: sheetSettings,
                title: 'Settings — edited on both sides'
            });
        }

        return items;
    }

    _buildMergedEquipmentList(localList, sheetList, items, selections) {
        const merged = this._mergeEquipmentList(localList, sheetList);
        const byId = new Map(merged.filter(x => x?.id).map(x => [x.id, x]));

        for (const item of items) {
            switch (item.type) {
                case 'modified': {
                    const choice = selections[item.id] || 'sheet';
                    const chosen = choice === 'local' ? item.local : item.sheet;
                    if (item.equipmentKind === 'settings') break;
                    if (chosen?.id) byId.set(chosen.id, { ...chosen });
                    break;
                }
                case 'local_only': {
                    const keep = selections[item.id] !== false;
                    if (!keep) byId.delete(item.entityId);
                    else if (item.local) byId.set(item.entityId, { ...item.local });
                    break;
                }
                case 'sheet_only': {
                    const keep = selections[item.id] !== false;
                    if (!keep) byId.delete(item.entityId);
                    break;
                }
                default:
                    break;
            }
        }

        return Array.from(byId.values());
    }

    _buildMergedSettings(localSettings, sheetSettings, settingsItem, selections) {
        const merged = { ...(localSettings || {}), ...(sheetSettings || {}) };
        if (!settingsItem) return merged;
        const choice = selections.settings || 'sheet';
        return choice === 'local'
            ? { ...(sheetSettings || {}), ...(localSettings || {}) }
            : { ...(localSettings || {}), ...(sheetSettings || {}) };
    }

    buildMergedEquipmentFromSelections(conflictData, selections) {
        const local = conflictData.localEquipment || {};
        const sheet = conflictData.sheetEquipment || {};
        const equipmentItems = conflictData.equipmentItems || [];
        const settingsItem = equipmentItems.find(i => i.equipmentKind === 'settings');

        return {
            harnesses: this._buildMergedEquipmentList(
                local.harnesses,
                sheet.harnesses,
                equipmentItems.filter(i => i.equipmentKind === 'harness'),
                selections
            ),
            canopies: this._buildMergedEquipmentList(
                local.canopies,
                sheet.canopies,
                equipmentItems.filter(i => i.equipmentKind === 'canopy'),
                selections
            ),
            locations: this._buildMergedEquipmentList(
                local.locations,
                sheet.locations,
                equipmentItems.filter(i => i.equipmentKind === 'location'),
                selections
            ),
            settings: this._buildMergedSettings(
                local.settings,
                sheet.settings,
                settingsItem,
                selections
            )
        };
    }

    /**
     * Build per-jump conflict items for the resolution UI.
     * @returns {Array<{id:string,type:string,jumpId?:string,local?:object,sheet?:object,title:string}>}
     */
    computeSyncConflictItems(localJumps, sheetJumps, deletedJumpIds) {
        const deletedSet = deletedJumpIds instanceof Set ? deletedJumpIds : new Set(deletedJumpIds);
        const localById = new Map();
        const sheetById = new Map();
        for (const j of localJumps) {
            if (j.jumpId) localById.set(j.jumpId, j);
        }
        for (const j of sheetJumps) {
            if (j.jumpId) sheetById.set(j.jumpId, j);
        }

        const items = [];
        const matchedLocalIds = new Set();
        const matchedSheetIds = new Set();

        for (const [jumpId, local] of localById) {
            const sheet = sheetById.get(jumpId);
            if (!sheet) continue;
            matchedLocalIds.add(jumpId);
            matchedSheetIds.add(jumpId);
            if (!this._jumpContentEqual(local, sheet)) {
                items.push({
                    id: jumpId,
                    jumpId,
                    type: 'modified',
                    local,
                    sheet,
                    title: `Jump #${local.jumpNumber || sheet.jumpNumber} — edited on both sides`
                });
            }
        }

        for (const [jumpId, local] of localById) {
            if (matchedLocalIds.has(jumpId)) continue;
            const contentMatch = sheetJumps.find(s =>
                s.jumpId && !matchedSheetIds.has(s.jumpId) && this._jumpContentEqual(local, s)
            );
            if (contentMatch) {
                matchedLocalIds.add(jumpId);
                matchedSheetIds.add(contentMatch.jumpId);
                continue;
            }
            if (deletedSet.has(jumpId)) {
                items.push({
                    id: `deleted:${jumpId}`,
                    jumpId,
                    type: 'deleted_on_sheet',
                    local,
                    title: `Jump #${local.jumpNumber} — deleted on sheet`
                });
            } else {
                items.push({
                    id: `local:${jumpId}`,
                    jumpId,
                    type: 'local_only',
                    local,
                    title: `Jump #${local.jumpNumber} — only on this device`
                });
            }
        }

        for (const j of sheetJumps) {
            const jumpId = j.jumpId;
            if (!jumpId || matchedSheetIds.has(jumpId) || deletedSet.has(jumpId)) continue;
            const contentMatch = localJumps.find(l =>
                l.jumpId && !matchedLocalIds.has(l.jumpId) && this._jumpContentEqual(l, j)
            );
            if (contentMatch) {
                matchedSheetIds.add(jumpId);
                continue;
            }
            items.push({
                id: `sheet:${jumpId}`,
                jumpId,
                type: 'sheet_only',
                sheet: j,
                title: `Jump #${j.jumpNumber} — only on sheet`
            });
        }

        return items;
    }

    /**
     * Apply user selections on top of the default merge (sheet wins on same-id edits).
     */
    buildMergedJumpsFromSelections(conflictData, selections) {
        const { localJumps, sheetJumps, deletedJumpIds } = conflictData;
        const items = conflictData.jumpItems || conflictData.items || [];
        const merged = this._mergeJumps(localJumps, sheetJumps, deletedJumpIds);
        const byId = new Map(merged.filter(j => j.jumpId).map(j => [j.jumpId, j]));

        for (const item of items) {
            switch (item.type) {
                case 'modified': {
                    const choice = selections[item.jumpId] || 'sheet';
                    const chosen = choice === 'local' ? item.local : item.sheet;
                    if (chosen?.jumpId) byId.set(chosen.jumpId, { ...chosen });
                    break;
                }
                case 'local_only': {
                    const keep = selections[item.id] !== false;
                    if (!keep) byId.delete(item.jumpId);
                    else if (item.local) byId.set(item.jumpId, { ...item.local });
                    break;
                }
                case 'sheet_only': {
                    const keep = selections[item.id] !== false;
                    if (!keep) byId.delete(item.jumpId);
                    break;
                }
                case 'deleted_on_sheet': {
                    const keep = selections[item.id] === 'keep';
                    if (keep && item.local) byId.set(item.jumpId, { ...item.local });
                    else byId.delete(item.jumpId);
                    break;
                }
                default:
                    break;
            }
        }

        return Array.from(byId.values());
    }

    async _presentSyncConflict(d, sheetTs) {
        const logbook = window.logbook;
        const localJumps = logbook ? [...logbook.jumps] : await DB.getAllJumps();
        const deletedJumpIds = await this.getDeletedJumpIds();
        const sheetJumps = await this.getAllJumps();
        const jumpItems = this.computeSyncConflictItems(localJumps, sheetJumps, deletedJumpIds);

        const localEquipment = logbook
            ? {
                harnesses: [...(logbook.harnesses || [])],
                canopies: JSON.parse(JSON.stringify(logbook.canopies || [])),
                locations: [...(logbook.locations || [])],
                settings: { ...(logbook.settings || {}) }
            }
            : {
                harnesses: await DB.getAll('harnesses'),
                canopies: await DB.getAll('canopies'),
                locations: await DB.getAll('locations'),
                settings: JSON.parse(localStorage.getItem('skydiving-settings') || '{}')
            };
        const sheetEquipment = {
            harnesses: d.harnesses || [],
            canopies: d.canopies || [],
            locations: d.locations || [],
            settings: d.settings || {}
        };
        const equipmentItems = this.computeEquipmentConflictItems(localEquipment, sheetEquipment);

        this._syncConflictPending = true;
        this._pendingConflict = {
            sheetData: d,
            sheetTs,
            localJumps,
            sheetJumps,
            deletedJumpIds,
            jumpItems,
            items: jumpItems,
            localEquipment,
            sheetEquipment,
            equipmentItems
        };
        this.updateSyncStatus('Conflict');

        if (logbook && typeof logbook.showSyncConflictModal === 'function') {
            logbook.showSyncConflictModal(this._pendingConflict);
        } else {
            console.warn('[Sync] Conflict detected but logbook UI unavailable — auto-merging');
            await this._pullAllFromSheet(d, sheetTs);
            await this._syncTodosAndTouchMetaIfChanged();
            this.clearSyncConflict();
        }
    }

    clearSyncConflict() {
        this._syncConflictPending = false;
        this._pendingConflict = null;
    }

    async completeConflictResolution(mergedJumps, mergedEquipment = null) {
        const conflict = this._pendingConflict;
        if (!conflict) return;

        const logbook = window.logbook;
        const eq = mergedEquipment || conflict.localEquipment || {
            harnesses: logbook?.harnesses || [],
            canopies: logbook?.canopies || [],
            locations: logbook?.locations || [],
            settings: logbook?.settings || {}
        };

        if (eq.harnesses) {
            await DB.replaceAll('harnesses', eq.harnesses).catch(err => console.error('[Sync] IDB harnesses write failed:', err));
        }
        if (eq.canopies) {
            await DB.replaceAll('canopies', eq.canopies).catch(err => console.error('[Sync] IDB canopies write failed:', err));
        }
        if (eq.locations) {
            await DB.replaceAll('locations', eq.locations).catch(err => console.error('[Sync] IDB locations write failed:', err));
        }
        if (eq.settings) {
            localStorage.setItem('skydiving-settings', JSON.stringify(eq.settings));
        }

        await DB.replaceAllJumps(mergedJumps);

        if (logbook) {
            if (eq.harnesses) logbook.harnesses = eq.harnesses;
            if (eq.canopies) logbook.canopies = eq.canopies;
            if (eq.settings) logbook.settings = eq.settings;
            if (eq.locations) {
                logbook.locations = eq.locations;
                logbook.locations.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
            }
            logbook.canopies.forEach(c => {
                if (!Array.isArray(c.linesets)) c.linesets = [];
                if (c.linesets.length === 0) {
                    c.linesets.push({ number: 1, hybrid: false, previousJumps: 0, jumpCount: 0, archived: false });
                }
            });

            logbook.jumps = mergedJumps;
            logbook.ensureJumpIds();
            logbook.forceRenumberJumpsAfterSync();
            logbook.initializeCanopyLinesetJumpCounts();
            logbook.updateEquipmentOptions();
            logbook.updateLocationDatalist();
            logbook.updateStats();
            logbook.renderJumpsList();
            if (logbook.currentView === 'equipment') logbook.renderEquipmentView();
            if (logbook.currentView === 'stats') logbook.renderStats();
            logbook.preFillFormWithLastJump();
            logbook.saveToLocalStorage();
        }

        const newTs = new Date().toISOString();
        await this.uploadAllJumps(mergedJumps);
        await this.syncTodosWithSheetSafe();
        await this.syncEquipmentToSheet(newTs);
        localStorage.setItem('skydiving-data-synced', newTs);
        localStorage.setItem('skydiving-data-modified', newTs);
        localStorage.removeItem('skydiving-needs-sync');

        this.clearSyncConflict();
        this.updateSyncStatus('Synced');
        setTimeout(() => this.updateSyncStatus('Online'), 2000);
        console.log('[Sync] Conflict resolved and pushed, ts:', newTs);
    }

    // ── Sync logic (same as before, transport-agnostic) ─────────────────

    async doStartupSync() {
        if (!this.initialized) return;

        // Never trigger interactive sign-in at startup — bail silently so the
        // user can initiate auth manually by pressing the sync button.
        if (!window.AuthManager.isSignedIn()) {
            this.updateSyncStatus('Not signed in');
            return;
        }

        if (this._syncInProgress) {
            console.log('[Startup] Sync skipped — another sync in progress');
            this._schedulePoll();
            return;
        }
        this._syncInProgress = true;

        this._cancelPoll();
        this.updateSyncStatus('Syncing...');

        try {
            const d             = await this._getEquipment();
            const sheetTs       = (d._syncMeta && d._syncMeta.dataModified) || '';
            const sheetDeviceId = (d._syncMeta && d._syncMeta.deviceId) || null;
            const localSynced   = localStorage.getItem('skydiving-data-synced') || '';
            const localModified = localStorage.getItem('skydiving-data-modified') || '';

            const hasSheetData = !!(d.harnesses || d.canopies);
            const sheetIsNewer = (sheetTs && sheetTs > localSynced) ||
                                 (hasSheetData && !localSynced && !sheetTs);
            const hasPending   = !!(localModified && localModified > localSynced);
            const lastWriteFromThisDevice = sheetDeviceId && sheetDeviceId === this.getDeviceId();

            if (sheetIsNewer && !lastWriteFromThisDevice) {
                if (this._hasSyncConflict(d, localSynced, localModified)) {
                    console.warn('[Startup] Conflict — sheet is newer and local has pending changes');
                    await this._presentSyncConflict(d, sheetTs);
                    await this.syncTodosWithSheetSafe();
                } else {
                    console.log('[Startup] Sheet is newer, pulling all data...');
                    await this._pullAllFromSheet(d, sheetTs);
                    await this._syncTodosAndTouchMetaIfChanged();
                }
            } else if (sheetIsNewer && lastWriteFromThisDevice) {
                console.log('[Startup] Sheet newer but last write from this device — pushing only (no pull)');
                const newTs   = new Date().toISOString();
                const logbook = window.logbook;
                await this.uploadAllJumps(logbook?.jumps || []);
                await this.syncTodosWithSheetSafe();
                await this.syncEquipmentToSheet(newTs);
                localStorage.setItem('skydiving-data-synced', newTs);
                localStorage.setItem('skydiving-data-modified', newTs);
                console.log('[Sync] Startup push complete (same device), ts:', newTs);
            } else if (hasPending) {
                console.log('[Startup] Pending local changes, pushing...');
                const newTs   = new Date().toISOString();
                const logbook = window.logbook;
                await this.uploadAllJumps(logbook?.jumps || []);
                await this.syncTodosWithSheetSafe();
                await this.syncEquipmentToSheet(newTs);
                localStorage.setItem('skydiving-data-synced', newTs);
                localStorage.setItem('skydiving-data-modified', newTs);
                console.log('[Sync] Startup push complete, ts:', newTs);
            } else {
                const todoResult = await this._syncTodosAndTouchMetaIfChanged();
                if (todoResult.changed) {
                    console.log('[Sync] Startup todos-only push complete');
                }
            }

            if (!this._syncConflictPending) {
                this.updateSyncStatus('Online');
            }
        } catch (error) {
            // If the stored spreadsheet was deleted or is inaccessible (404),
            // clear the stale ID and try to find the real one on Drive.
            if (error.message && error.message.includes('404') && !this._recoveryAttempted) {
                console.warn('[Startup] Spreadsheet not found (404) — searching Drive for existing one...');
                this._recoveryAttempted = true;
                localStorage.removeItem('oauth-spreadsheet-id');
                this.spreadsheetId = '';
                this.initialized = false;
                this._syncInProgress = false;

                try {
                    const newId = await this.findOrCreateSpreadsheet();
                    if (newId) {
                        this.reinitialize(newId);
                        await this.doStartupSync();
                        return;
                    }
                } catch (recoveryError) {
                    console.error('[Startup] Recovery failed:', recoveryError);
                }
            }

            console.error('[Startup] Sync failed:', error);
            this.updateSyncStatus('Sync failed');
            setTimeout(() => this.updateSyncStatus('Unsynced'), 3000);
        } finally {
            this._recoveryAttempted = false;
            this._syncInProgress = false;
            this._schedulePoll();
        }
    }

    async syncWithSheet() {
        await this.ready;
        await this.doStartupSync();
    }

    async pushAllWithGuard() {
        if (!this.initialized || !navigator.onLine) return;
        if (!window.AuthManager.isSignedIn()) {
            this.updateSyncStatus('Unsynced');
            return;
        }
        if (this._syncConflictPending) {
            console.log('[Sync] Push skipped — sync conflict awaiting user resolution');
            return;
        }
        if (this._syncInProgress) {
            console.log('[Sync] Push skipped — another sync in progress');
            return;
        }
        this._syncInProgress = true;

        this.updateSyncStatus('Syncing...');

        try {
            const d             = await this._getEquipment();
            const sheetTs       = (d._syncMeta && d._syncMeta.dataModified) || '';
            const sheetDeviceId = (d._syncMeta && d._syncMeta.deviceId) || null;
            const localSynced   = localStorage.getItem('skydiving-data-synced') || '';

            const localModified = localStorage.getItem('skydiving-data-modified') || '';

            const lastWriteFromThisDevice = sheetDeviceId && sheetDeviceId === this.getDeviceId();

            if (this._hasSyncConflict(d, localSynced, localModified)) {
                console.warn('[Sync] Conflict — sheet is newer and local has pending changes');
                await this._presentSyncConflict(d, sheetTs);
                await this.syncTodosWithSheetSafe();
                this.updateSyncStatus('Conflict');
                return;
            }

            if (sheetTs && sheetTs > localSynced && !lastWriteFromThisDevice) {
                console.warn('[Sync] Sheet is newer (other device) — pulling and merging');
                await this._pullAllFromSheet(d, sheetTs);
                await this._syncTodosAndTouchMetaIfChanged();
                this.updateSyncStatus('Online');
                return;
            }
            if (sheetTs && sheetTs > localSynced && lastWriteFromThisDevice) {
                console.log('[Sync] Sheet newer but last write from this device — pushing only');
            }

            const newTs   = new Date().toISOString();
            const logbook = window.logbook;
            await this.uploadAllJumps(logbook?.jumps || []);
            await this.syncTodosWithSheetSafe();
            await this.syncEquipmentToSheet(newTs);

            localStorage.setItem('skydiving-data-synced', newTs);
            localStorage.setItem('skydiving-data-modified', newTs);

            this.updateSyncStatus('Synced');
            setTimeout(() => this.updateSyncStatus('Online'), 2000);
            console.log('[Sync] Push complete, ts:', newTs);
        } catch (error) {
            console.error('[Sync] pushAllWithGuard failed:', error);
            this.updateSyncStatus('Sync failed');
            setTimeout(() => this.updateSyncStatus('Unsynced'), 3000);
        } finally {
            this._syncInProgress = false;
        }
    }

    async _pullAllFromSheet(d, sheetDataModified) {
        const logbook = window.logbook;

        const localJumps = logbook ? [...logbook.jumps]
            : await DB.getAllJumps();

        if (d.harnesses)  DB.replaceAll('harnesses', d.harnesses).catch(err => console.error('[Sync] IDB harnesses write failed:', err));
        if (d.canopies)   DB.replaceAll('canopies',  d.canopies).catch(err => console.error('[Sync] IDB canopies write failed:', err));
        if (d.locations)   DB.replaceAll('locations',  d.locations).catch(err => console.error('[Sync] IDB locations write failed:', err));
        if (d.settings)    localStorage.setItem('skydiving-settings', JSON.stringify(d.settings));

        const deletedJumpIds = await this.getDeletedJumpIds();
        const sheetJumps = await this.getAllJumps();
        const mergedJumps = this._mergeJumps(localJumps, sheetJumps, deletedJumpIds);
        await DB.replaceAllJumps(mergedJumps);

        const ts = sheetDataModified || new Date().toISOString();
        localStorage.setItem('skydiving-data-synced', ts);

        if (mergedJumps.length > sheetJumps.length) {
            console.log(`[Sync] Merge recovered ${mergedJumps.length - sheetJumps.length} local-only jump(s)`);
            localStorage.setItem('skydiving-data-modified', new Date().toISOString());
        } else {
            localStorage.setItem('skydiving-data-modified', ts);
        }

        if (logbook) {
            if (d.harnesses)  logbook.harnesses  = d.harnesses;
            if (d.canopies)   logbook.canopies   = d.canopies;
            if (d.settings)   logbook.settings   = d.settings;
            if (d.locations) {
                logbook.locations = d.locations;
                logbook.locations.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
            }

            logbook.canopies.forEach(c => {
                if (!Array.isArray(c.linesets)) c.linesets = [];
                if (c.linesets.length === 0) c.linesets.push({ number: 1, hybrid: false, previousJumps: 0, jumpCount: 0, archived: false });
            });

            logbook.jumps = mergedJumps;
            logbook.forceRenumberJumpsAfterSync();
            logbook.initializeCanopyLinesetJumpCounts();
            logbook.updateEquipmentOptions();
            logbook.updateLocationDatalist();
            logbook.updateStats();
            logbook.renderJumpsList();
            if (logbook.currentView === 'equipment') logbook.renderEquipmentView();
            if (logbook.currentView === 'stats') logbook.renderStats();
            logbook.preFillFormWithLastJump();
        }

        console.log('[Sync] Pulled and merged data from sheet, ts:', ts);
    }

    /**
     * True if two jumps have the same jumpNumber and same values for all fields except jumpId/id.
     * Used to avoid duplicating the same logical jump when local and sheet have different IDs.
     */
    _jumpContentEqual(a, b) {
        if (!a || !b) return false;
        const num = (n) => (typeof n === 'number' && !Number.isNaN(n)) ? n : parseInt(n, 10) || 0;
        if (num(a.jumpNumber) !== num(b.jumpNumber)) return false;
        const str = (s) => (s == null ? '' : String(s)).trim();
        const harnessNorm = (j) => str(j?.harnessId);
        const harnessCompatible = (a, b) => {
            const ha = harnessNorm(a);
            const hb = harnessNorm(b);
            if (ha === hb) return true;
            // Legacy sheet rows without Harness ID: do not duplicate-merge against local rows that only add harnessId.
            if (!ha || !hb) return true;
            return false;
        };
        const dateNorm = (d) => {
            const s = str(d);
            if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
            const t = new Date(s).getTime();
            return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : s;
        };
        return (
            dateNorm(a.date) === dateNorm(b.date) &&
            str(a.location) === str(b.location) &&
            str(a.equipment) === str(b.equipment) &&
            str(a.notes) === str(b.notes) &&
            num(a.linesetNumber) === num(b.linesetNumber) &&
            str(a.timestamp) === str(b.timestamp) &&
            harnessCompatible(a, b)
        );
    }

    /** Merge by jumpId. Only exclude jumps that are in deletedJumpIds. Local jumps not on sheet are kept (recovered).
     * If a local jump has the same jumpNumber and identical data as a sheet jump (only jumpId differs), we keep the
     * sheet row and do not duplicate — effectively adopting the sheet's jumpId for that jump. */
    _mergeJumps(localJumps, sheetJumps, deletedJumpIds) {
        const deletedSet = deletedJumpIds instanceof Set ? deletedJumpIds : new Set(deletedJumpIds);
        const sheetJumpIds = new Set(
            sheetJumps.map(j => j.jumpId).filter(Boolean)
        );
        const merged = sheetJumps.filter(j => !j.jumpId || !deletedSet.has(j.jumpId));
        for (const j of localJumps) {
            const jumpId = j.jumpId || SheetsAPI.generateJumpId();
            if (!j.jumpId) j.jumpId = jumpId;
            if (deletedSet.has(jumpId)) continue;
            if (sheetJumpIds.has(jumpId)) continue; // already in merged from sheet
            // Local-only by ID: check if any sheet jump is the same row (same jumpNumber + same content)
            const sameIdx = merged.findIndex(sheetJump => this._jumpContentEqual(j, sheetJump));
            if (sameIdx !== -1) {
                const sheetJump = merged[sameIdx];
                const hl = (j.harnessId == null || j.harnessId === '') ? '' : String(j.harnessId).trim();
                const hs = (sheetJump.harnessId == null || sheetJump.harnessId === '') ? '' : String(sheetJump.harnessId).trim();
                if (hl && !hs) sheetJump.harnessId = hl;
                continue;
            }
            merged.push(j);
        }
        return merged;
    }

    async doPendingPush() {
        if (!this.initialized || !navigator.onLine) return;
        if (!window.AuthManager.isSignedIn()) return; // bail silently — background poll must not show sign-in UI
        if (this._syncConflictPending) return;
        if (this._syncInProgress) return;
        this._syncInProgress = true;

        try {
            const localModified = localStorage.getItem('skydiving-data-modified') || '';
            const localSynced   = localStorage.getItem('skydiving-data-synced') || '';

            if (localModified && localModified > localSynced) {
                this.updateSyncStatus('Syncing...');
                const d             = await this._getEquipment();
                const sheetTs       = (d._syncMeta && d._syncMeta.dataModified) || '';
                const sheetDeviceId = (d._syncMeta && d._syncMeta.deviceId) || null;
                const lastWriteFromThisDevice = sheetDeviceId && sheetDeviceId === this.getDeviceId();

                if (this._hasSyncConflict(d, localSynced, localModified)) {
                    console.warn('[Poll] Conflict — sheet is newer and local has pending changes');
                    await this._presentSyncConflict(d, sheetTs);
                    await this.syncTodosWithSheetSafe();
                    this.updateSyncStatus('Conflict');
                    return;
                }

                if (sheetTs && sheetTs > localSynced && !lastWriteFromThisDevice) {
                    console.warn('[Poll] Sheet is newer (other device) — pulling and merging');
                    await this._pullAllFromSheet(d, sheetTs);
                    await this._syncTodosAndTouchMetaIfChanged();
                } else {
                    const newTs   = new Date().toISOString();
                    const logbook = window.logbook;
                    await this.uploadAllJumps(logbook?.jumps || []);
                    await this.syncTodosWithSheetSafe();
                    await this.syncEquipmentToSheet(newTs);
                    localStorage.setItem('skydiving-data-synced', newTs);
                    localStorage.setItem('skydiving-data-modified', newTs);
                    console.log('[Poll] Push complete, ts:', newTs);
                }
                this.updateSyncStatus('Synced');
                setTimeout(() => this.updateSyncStatus('Online'), 2000);
                return;
            }

            // No pending changes — quietly check if sheet is newer (and from another device)
            const d             = await this._getEquipment();
            const sheetTs       = (d._syncMeta && d._syncMeta.dataModified) || '';
            const sheetDeviceId = (d._syncMeta && d._syncMeta.deviceId) || null;
            const lastWriteFromThisDevice = sheetDeviceId && sheetDeviceId === this.getDeviceId();
            if (sheetTs && sheetTs > localSynced && !lastWriteFromThisDevice) {
                console.log('[Poll] Sheet is newer (other device), pulling and merging...');
                this.updateSyncStatus('Syncing...');
                await this._pullAllFromSheet(d, sheetTs);
                await this._syncTodosAndTouchMetaIfChanged();
                this.updateSyncStatus('Synced');
                setTimeout(() => this.updateSyncStatus('Online'), 2000);
            }
        } catch (error) {
            console.warn('[Poll] doPendingPush failed:', error);
            this.updateSyncStatus('Sync failed');
            setTimeout(() => this.updateSyncStatus('Unsynced'), 3000);
        } finally {
            this._syncInProgress = false;
        }
    }

    /**
     * Called by the sync button. If not configured, triggers the full sign-in
     * and spreadsheet setup flow. If the token is expired, refreshes it first,
     * then performs a full sync and starts the background poll.
     */
    async userInitiatedSync() {
        if (!navigator.onLine) {
            this.updateSyncStatus('Offline');
            return;
        }

        // If not initialized (no spreadsheet configured), trigger the full
        // sign-in flow from app.js which handles OAuth + spreadsheet discovery.
        if (!this.initialized || !window.AuthManager.isSignedIn()) {
            if (window.logbook && typeof window.logbook.handleGoogleSignIn === 'function') {
                await window.logbook.handleGoogleSignIn();
                return;
            }
            this.updateSyncStatus('Not signed in');
            return;
        }

        // doStartupSync handles push/pull conflict detection and schedules the poll
        await this.doStartupSync();
    }

    // ── Polling ─────────────────────────────────────────────────────────

    _schedulePoll(intervalMs = 120000) {
        this._cancelPoll();
        if (!this.initialized) return;
        this._pollTimer = setTimeout(() => {
            if (navigator.onLine) {
                console.log('[Poll] Auto-sync triggered');
                this.doPendingPush().finally(() => this._schedulePoll(intervalMs));
            } else {
                this._schedulePoll(intervalMs);
            }
        }, intervalMs);
    }

    _cancelPoll() {
        if (this._pollTimer !== null) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    }

    // ── UI helpers ──────────────────────────────────────────────────────

    updateSyncStatus(status) {
        const syncElement = document.getElementById('syncStatus');
        const syncBtn = document.getElementById('syncBtn');
        if (syncElement) {
            syncElement.textContent = status;

            syncElement.className = 'sync-status';
            if (status === 'Syncing...' || status === 'Uploading jumps...') {
                syncElement.classList.add('syncing');
            } else if (status === 'Synced' || status === 'Online' || status === 'Ready') {
                syncElement.classList.add('success');
            } else if (status === 'Unsynced' || status === 'Not signed in') {
                syncElement.classList.add('warning');
            } else if (status === 'Conflict') {
                syncElement.classList.add('warning');
            } else if (status.includes('failed') || status.includes('error')) {
                syncElement.classList.add('error');
            }
        }
        if (syncBtn) {
            if (status === 'Syncing...' || status === 'Uploading jumps...') {
                syncBtn.classList.add('syncing');
                syncBtn.classList.remove('unsynced');
            } else if (status === 'Unsynced' || status === 'Not signed in') {
                syncBtn.classList.remove('syncing');
                syncBtn.classList.add('unsynced');
            } else if (status === 'Conflict') {
                syncBtn.classList.remove('syncing');
                syncBtn.classList.add('unsynced');
            } else {
                syncBtn.classList.remove('syncing');
                syncBtn.classList.remove('unsynced');
            }
        }
    }
}

// Initialise global instance
window.SheetsAPI = new SheetsAPI();

// Wire up the sync button
document.addEventListener('DOMContentLoaded', () => {
    const syncBtn = document.getElementById('syncBtn');
    if (syncBtn) {
        syncBtn.onclick = () => window.SheetsAPI.userInitiatedSync();
    }
});
