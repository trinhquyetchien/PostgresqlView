"use strict";

const STORAGE_KEY = "postgresql-view.connection";
const CARD_WIDTH = 320;
const CARD_HEADER_HEIGHT = 112;
const COLUMN_HEIGHT = 38;
const CARD_BOTTOM_PADDING = 20;
const STAGE_PADDING = 88;
const GROUP_HEADER_HEIGHT = 70;
const GROUP_FRAME_PADDING = 28;
const GROUP_FRAME_EXTRA_BOTTOM = 30;
const GROUP_GAP_X = 96;
const GROUP_GAP_Y = 88;
const GROUP_COLUMN_GAP = 64;
const GROUP_ROW_GAP = 52;
const TABLE_COLLISION_GAP = 24;
const EDGE_GRID_SIZE = 36;
const EDGE_CLEARANCE = 32;
const EDGE_PORT_OFFSET = 56;
const EDGE_CORNER_RADIUS = 12;
const SEARCH_DEBOUNCE_MS = 110;
const FAST_EDGE_RELATION_THRESHOLD = 180;
const FAST_EDGE_TABLE_THRESHOLD = 72;
const LIVE_EDGE_PORT_OFFSET = 44;

const state = {
  schema: null,
  search: "",
  selectedTableId: null,
  activeSchemas: new Set(),
  visibleTableIds: new Set(),
  currentTables: [],
  currentRelationships: [],
  manualTablePositions: new Map(),
  layout: {
    tables: new Map(),
    groups: [],
    width: 0,
    height: 0,
  },
  view: {
    x: 72,
    y: 72,
    scale: 1,
  },
  pan: null,
  drag: null,
  suppressClickUntil: 0,
  dragFrameRequested: false,
  dragFrameTableId: null,
  searchDebounceTimer: 0,
};

const elements = {
  form: document.querySelector("#connection-form"),
  host: document.querySelector("#host"),
  port: document.querySelector("#port"),
  database: document.querySelector("#database"),
  user: document.querySelector("#user"),
  password: document.querySelector("#password"),
  sslmode: document.querySelector("#sslmode"),
  connectButton: document.querySelector("#connect-button"),
  clearButton: document.querySelector("#clear-button"),
  statusMessage: document.querySelector("#status-message"),
  stats: document.querySelector("#stats"),
  schemaFilters: document.querySelector("#schema-filters"),
  searchInput: document.querySelector("#search-input"),
  tableList: document.querySelector("#table-list"),
  inspector: document.querySelector("#inspector"),
  workspaceTitle: document.querySelector("#workspace-title"),
  workspaceMeta: document.querySelector("#workspace-meta"),
  workspaceSummary: document.querySelector("#workspace-summary"),
  resetButton: document.querySelector("#reset-button"),
  viewport: document.querySelector("#graph-viewport"),
  stage: document.querySelector("#graph-stage"),
  edges: document.querySelector("#graph-edges"),
  schemas: document.querySelector("#graph-schemas"),
  nodes: document.querySelector("#graph-nodes"),
  emptyState: document.querySelector("#empty-state"),
};

bootstrap();

function bootstrap() {
  hydrateForm();
  bindEvents();
  render();
}

function bindEvents() {
  elements.form.addEventListener("submit", handleSubmit);
  elements.clearButton.addEventListener("click", handleClearForm);
  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.resetButton.addEventListener("click", handleResetView);
  elements.tableList.addEventListener("click", handleTableListClick);
  elements.schemaFilters.addEventListener("click", handleSchemaFilterClick);
  elements.nodes.addEventListener("pointerdown", handleCardPointerDown);
  elements.nodes.addEventListener("click", handleNodeClick);
  elements.viewport.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
  elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("resize", () => {
    if (state.schema) {
      render();
    }
  });
}

function hydrateForm() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const stored = JSON.parse(raw);
    if (stored.host) {
      elements.host.value = stored.host;
    }
    if (stored.port) {
      elements.port.value = stored.port;
    }
    if (stored.database) {
      elements.database.value = stored.database;
    }
    if (stored.user) {
      elements.user.value = stored.user;
    }
    if (stored.sslmode) {
      elements.sslmode.value = stored.sslmode;
    }
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const payload = {
    host: elements.host.value.trim(),
    port: elements.port.value.trim(),
    database: elements.database.value.trim(),
    user: elements.user.value.trim(),
    password: elements.password.value,
    sslmode: elements.sslmode.value,
  };

  setStatus("Đang đọc schema từ PostgreSQL...", "loading");
  setLoading(true);

  try {
    const response = await fetch("/api/schema", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Không đọc được schema.");
    }

    state.schema = enhanceSchema(data);
    state.search = "";
    state.selectedTableId = state.schema.tables[0] ? state.schema.tables[0].id : null;
    state.activeSchemas = new Set(state.schema.schemas);
    state.manualTablePositions = new Map();
    state.pan = null;
    state.drag = null;
    state.dragFrameTableId = null;
    state.suppressClickUntil = 0;
    if (state.searchDebounceTimer) {
      window.clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = 0;
    }
    state.view = { x: 72, y: 72, scale: 1 };
    elements.viewport.classList.remove("is-panning");
    elements.searchInput.value = "";
    elements.password.value = "";
    persistConnection(payload);
    setStatus(`Đã tải ${state.schema.tables.length} bảng và ${state.schema.relationships.length} quan hệ.`, "success");
    render();
    fitToViewport();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setLoading(false);
  }
}

function handleClearForm() {
  elements.form.reset();
  elements.port.value = "5432";
  elements.sslmode.value = "prefer";
  window.localStorage.removeItem(STORAGE_KEY);
  setStatus("Đã xóa thông tin kết nối đã lưu.", "success");
}

function handleResetView() {
  if (!state.schema) {
    resetViewport();
    return;
  }

  state.manualTablePositions = new Map();
  render();
  fitToViewport();
  setStatus("Đã reset layout và góc nhìn.", "success");
}

function handleSearchInput(event) {
  const nextSearch = event.target.value.trim().toLowerCase();

  if (state.searchDebounceTimer) {
    window.clearTimeout(state.searchDebounceTimer);
  }

  state.searchDebounceTimer = window.setTimeout(() => {
    state.searchDebounceTimer = 0;

    if (state.search === nextSearch) {
      return;
    }

    state.search = nextSearch;
    render();
  }, SEARCH_DEBOUNCE_MS);
}

function handleTableListClick(event) {
  const button = event.target.closest("[data-table-id]");
  if (!button) {
    return;
  }

  const tableId = button.getAttribute("data-table-id");
  if (!tableId) {
    return;
  }

  selectTable(tableId, { center: true });
}

function handleSchemaFilterClick(event) {
  const button = event.target.closest("[data-schema-filter]");
  if (!button || !state.schema) {
    return;
  }

  const schema = button.getAttribute("data-schema-filter");
  if (!schema) {
    return;
  }

  if (schema === "__all__") {
    state.activeSchemas = new Set(state.schema.schemas);
    render();
    return;
  }

  if (state.activeSchemas.has(schema)) {
    state.activeSchemas.delete(schema);
  } else {
    state.activeSchemas.add(schema);
  }

  render();
}

function handleCardPointerDown(event) {
  const handle = event.target.closest("[data-drag-handle]");
  const card = event.target.closest("[data-card-table-id]");

  if (!handle || !card || !state.schema) {
    return;
  }

  const tableId = card.getAttribute("data-card-table-id");
  if (!tableId) {
    return;
  }

  const position = state.layout.tables.get(tableId);
  if (!position) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  state.drag = {
    pointerId: event.pointerId,
    tableId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    originX: position.x,
    originY: position.y,
    moved: false,
  };
  state.pan = null;
  state.selectedTableId = tableId;
  state.suppressClickUntil = 0;

  updateSelectionUI();
  elements.viewport.classList.remove("is-panning");

  if (typeof card.setPointerCapture === "function") {
    try {
      card.setPointerCapture(event.pointerId);
    } catch {
      // Ignore pointer capture failures and continue dragging.
    }
  }

  card.classList.add("is-dragging");
}

function handleNodeClick(event) {
  if (Date.now() < state.suppressClickUntil) {
    return;
  }

  const card = event.target.closest("[data-card-table-id]");
  if (!card) {
    return;
  }

  const tableId = card.getAttribute("data-card-table-id");
  if (!tableId) {
    return;
  }

  selectTable(tableId, { center: false });
}

function handlePointerDown(event) {
  if (event.button !== 0 || state.drag) {
    return;
  }

  if (event.target.closest(".erd-card")) {
    return;
  }

  state.pan = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    originX: state.view.x,
    originY: state.view.y,
  };
  elements.viewport.classList.add("is-panning");
}

function handlePointerMove(event) {
  if (state.drag) {
    if (state.drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = (event.clientX - state.drag.startClientX) / state.view.scale;
    const deltaY = (event.clientY - state.drag.startClientY) / state.view.scale;

    if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
      state.drag.moved = true;
    }

    moveTable(state.drag.tableId, state.drag.originX + deltaX, state.drag.originY + deltaY, deltaX, deltaY);
    return;
  }

  if (!state.pan || state.pan.pointerId !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - state.pan.x;
  const deltaY = event.clientY - state.pan.y;

  state.view.x = state.pan.originX + deltaX;
  state.view.y = state.pan.originY + deltaY;
  applyViewport();
}

function handlePointerUp(event) {
  if (state.drag && state.drag.pointerId === event.pointerId) {
    const drag = state.drag;
    const card = findCardElement(drag.tableId);

    if (card) {
      card.classList.remove("is-dragging");

      if (typeof card.releasePointerCapture === "function") {
        try {
          card.releasePointerCapture(event.pointerId);
        } catch {
          // Ignore release failures.
        }
      }
    }

    state.drag = null;

    if (drag.moved) {
      state.suppressClickUntil = Date.now() + 220;
      flushDragLayout();
    }

    return;
  }

  if (!state.pan || state.pan.pointerId !== event.pointerId) {
    return;
  }

  state.pan = null;
  elements.viewport.classList.remove("is-panning");
}

function handleWheel(event) {
  if (!state.schema) {
    return;
  }

  event.preventDefault();

  const viewport = getViewportRect();
  const pointerX = event.clientX - viewport.left;
  const pointerY = event.clientY - viewport.top;
  const factor = event.deltaY < 0 ? 1.08 : 0.92;
  const nextScale = clamp(state.view.scale * factor, 0.35, 1.7);
  const worldX = (pointerX - state.view.x) / state.view.scale;
  const worldY = (pointerY - state.view.y) / state.view.scale;

  state.view.scale = nextScale;
  state.view.x = pointerX - worldX * nextScale;
  state.view.y = pointerY - worldY * nextScale;
  applyViewport();
}

function persistConnection(payload) {
  const valueToStore = {
    host: payload.host,
    port: payload.port,
    database: payload.database,
    user: payload.user,
    sslmode: payload.sslmode,
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(valueToStore));
}

function setLoading(isLoading) {
  elements.connectButton.disabled = isLoading;
  elements.connectButton.textContent = isLoading ? "Đang đọc..." : "Đọc schema";
}

function setStatus(message, tone) {
  elements.statusMessage.textContent = message || "";
  if (tone) {
    elements.statusMessage.dataset.tone = tone;
  } else {
    delete elements.statusMessage.dataset.tone;
  }
}

function enhanceSchema(schema) {
  const foreignKeyMap = new Map();
  const relationsByTable = new Map();

  for (const relation of schema.relationships) {
    relation.sourceTableId = `${relation.source.schema}.${relation.source.table}`;
    relation.targetTableId = `${relation.target.schema}.${relation.target.table}`;

    for (const columnName of relation.source.columns) {
      foreignKeyMap.set(`${relation.sourceTableId}:${columnName}`, true);
    }

    linkRelation(relationsByTable, relation.sourceTableId, relation);
    linkRelation(relationsByTable, relation.targetTableId, relation);
  }

  const tables = schema.tables.map((table) => {
    const columns = table.columns.map((column) => ({
      ...column,
      isForeignKey: foreignKeyMap.has(`${table.id}:${column.name}`),
    }));
    const primaryKeyCount = columns.filter((column) => column.isPrimaryKey).length;
    const foreignKeyCount = columns.filter((column) => column.isForeignKey).length;
    const nullableCount = columns.filter((column) => column.nullable).length;
    const identityCount = columns.filter((column) => column.isIdentity).length;
    const defaultCount = columns.filter((column) => column.hasDefault).length;

    return {
      ...table,
      columns,
      relationCount: (relationsByTable.get(table.id) || []).length,
      primaryKeyCount,
      foreignKeyCount,
      nullableCount,
      identityCount,
      defaultCount,
      searchText: [
        table.schema,
        table.name,
        `${table.schema}.${table.name}`,
        ...columns.map((column) => `${column.name} ${column.dataType}`),
      ]
        .join(" ")
        .toLowerCase(),
    };
  });

  const schemas = [...new Set(tables.map((table) => table.schema))].sort((left, right) => left.localeCompare(right));

  return {
    ...schema,
    tables,
    schemas,
    tableMap: new Map(tables.map((table) => [table.id, table])),
    relationsByTable,
  };
}

function linkRelation(relationsByTable, tableId, relation) {
  if (!relationsByTable.has(tableId)) {
    relationsByTable.set(tableId, []);
  }

  relationsByTable.get(tableId).push(relation);
}

function render() {
  if (!state.schema) {
    renderDisconnectedState();
    return;
  }

  state.visibleTableIds = computeVisibleTableIds();
  state.currentTables = sortTablesForDisplay(state.schema.tables.filter((table) => state.visibleTableIds.has(table.id)));
  state.currentRelationships = state.schema.relationships.filter(
    (relation) => state.visibleTableIds.has(relation.sourceTableId) && state.visibleTableIds.has(relation.targetTableId),
  );

  if (state.selectedTableId && !state.visibleTableIds.has(state.selectedTableId)) {
    state.selectedTableId = state.currentTables[0] ? state.currentTables[0].id : null;
  }

  if (!state.selectedTableId && state.currentTables[0]) {
    state.selectedTableId = state.currentTables[0].id;
  }

  state.layout = buildLayout(state.currentTables);

  renderStats();
  renderSchemaFilters();
  renderTableList();
  renderWorkspaceHeader();
  renderWorkspaceSummary();
  renderInspector();
  renderGraph();
  applyViewport();
}

function renderDisconnectedState() {
  state.currentTables = [];
  state.currentRelationships = [];
  state.layout = {
    tables: new Map(),
    groups: [],
    width: getViewportRect().width,
    height: getViewportRect().height,
  };

  elements.emptyState.hidden = false;
  elements.stats.innerHTML = `
    <article class="stat-card">
      <span class="stat-label">Database</span>
      <strong class="stat-value">Chưa tải</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">Tables</span>
      <strong class="stat-value">0</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">Relations</span>
      <strong class="stat-value">0</strong>
    </article>
  `;
  elements.schemaFilters.innerHTML = "";
  elements.tableList.innerHTML = `
    <p class="inspector-empty">
      Chưa có dữ liệu. Sau khi kết nối thành công, danh sách bảng sẽ xuất hiện ở đây.
    </p>
  `;
  elements.workspaceTitle.textContent = "Sơ đồ schema";
  elements.workspaceMeta.textContent = "Chưa có dữ liệu";
  elements.workspaceSummary.innerHTML = "";
  elements.inspector.innerHTML = `
    <p class="inspector-empty">
      Chọn một bảng để xem cột, kiểu dữ liệu và các quan hệ liên quan.
    </p>
  `;
  elements.schemas.innerHTML = "";
  elements.nodes.innerHTML = "";
  elements.edges.innerHTML = "";
  applyStageMetrics();
}

function computeVisibleTableIds() {
  if (!state.schema) {
    return new Set();
  }

  const visibleIds = new Set();
  const hasSearch = Boolean(state.search);

  for (const table of state.schema.tables) {
    if (!isSchemaVisible(table.schema)) {
      continue;
    }

    if (!hasSearch || tableMatchesSearch(table, state.search)) {
      visibleIds.add(table.id);
    }
  }

  if (hasSearch) {
    for (const relation of state.schema.relationships) {
      if (visibleIds.has(relation.sourceTableId) || visibleIds.has(relation.targetTableId)) {
        const sourceTable = state.schema.tableMap.get(relation.sourceTableId);
        const targetTable = state.schema.tableMap.get(relation.targetTableId);

        if (sourceTable && isSchemaVisible(sourceTable.schema)) {
          visibleIds.add(sourceTable.id);
        }
        if (targetTable && isSchemaVisible(targetTable.schema)) {
          visibleIds.add(targetTable.id);
        }
      }
    }
  }

  return visibleIds;
}

function tableMatchesSearch(table, search) {
  return table.searchText.includes(search);
}

function sortTablesForDisplay(tables) {
  return tables
    .slice()
    .sort(
      (left, right) =>
        left.schema.localeCompare(right.schema) ||
        right.relationCount - left.relationCount ||
        right.columns.length - left.columns.length ||
        left.name.localeCompare(right.name),
    );
}

function renderStats() {
  elements.stats.innerHTML = `
    <article class="stat-card">
      <span class="stat-label">Database</span>
      <strong class="stat-value">${escapeHtml(state.schema.database)}</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">Tables</span>
      <strong class="stat-value">${state.currentTables.length}</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">Relations</span>
      <strong class="stat-value">${state.currentRelationships.length}</strong>
    </article>
  `;
}

function renderSchemaFilters() {
  const allActive = state.schema.schemas.length > 0 && state.activeSchemas.size === state.schema.schemas.length;

  elements.schemaFilters.innerHTML = [
    `<button class="chip ${allActive ? "is-active" : ""}" type="button" data-schema-filter="__all__">Tất cả</button>`,
    ...state.schema.schemas.map(
      (schema) =>
        `<button class="chip ${state.activeSchemas.has(schema) ? "is-active" : ""}" type="button" data-schema-filter="${escapeAttribute(schema)}">${escapeHtml(schema)}</button>`,
    ),
  ].join("");
}

function renderTableList() {
  if (!state.currentTables.length) {
    elements.tableList.innerHTML = `
      <p class="inspector-empty">
        Không có bảng nào khớp với bộ lọc hiện tại.
      </p>
    `;
    return;
  }

  elements.tableList.innerHTML = state.currentTables
    .map(
      (table) => `
        <button
          class="table-list-item ${table.id === state.selectedTableId ? "is-selected" : ""}"
          type="button"
          data-table-id="${escapeAttribute(table.id)}"
        >
          <div class="table-header-row">
            <span class="table-name">${escapeHtml(table.name)}</span>
            <span class="table-count">${table.relationCount} rel</span>
          </div>
          <div class="table-meta-row">
            <span class="table-meta">${escapeHtml(table.schema)}</span>
            <span class="table-meta">${table.columns.length} cột</span>
          </div>
          <div class="table-chip-row">
            <span class="meta-chip meta-chip-accent">${table.primaryKeyCount || 0} PK</span>
            <span class="meta-chip meta-chip-info">${table.foreignKeyCount || 0} FK</span>
            <span class="meta-chip meta-chip-muted">${table.nullableCount || 0} nullable</span>
          </div>
        </button>
      `,
    )
    .join("");
}

function renderWorkspaceHeader() {
  const generatedAt = formatDate(state.schema.generatedAt);
  const selectedTable = state.selectedTableId ? state.schema.tableMap.get(state.selectedTableId) : null;
  const selectedLabel = selectedTable ? ` • chọn ${selectedTable.schema}.${selectedTable.name}` : "";

  elements.workspaceTitle.textContent = `Sơ đồ schema • ${state.schema.database}`;
  elements.workspaceMeta.textContent = `${state.currentTables.length} bảng hiển thị • ${state.currentRelationships.length} quan hệ • cập nhật ${generatedAt} • kéo phần đầu bảng để đặt tay${selectedLabel}`;
}

function renderWorkspaceSummary() {
  if (!state.schema) {
    elements.workspaceSummary.innerHTML = "";
    return;
  }

  const selectedTable = state.selectedTableId ? state.schema.tableMap.get(state.selectedTableId) : null;
  const hiddenTables = Math.max(0, state.schema.tables.length - state.currentTables.length);
  const summaryItems = [
    {
      label: "Schema",
      value: `${state.activeSchemas.size}/${state.schema.schemas.length}`,
    },
    {
      label: "Edge",
      value: getEdgeRenderMode() === "smart" ? "Routing chi tiết" : "Turbo",
    },
    {
      label: "Đặt tay",
      value: `${state.manualTablePositions.size} bảng`,
    },
    {
      label: "Ẩn",
      value: `${hiddenTables}`,
    },
  ];

  if (selectedTable) {
    summaryItems.unshift({
      label: "Đang chọn",
      value: `${selectedTable.schema}.${selectedTable.name}`,
    });
  }

  elements.workspaceSummary.innerHTML = summaryItems
    .map(
      (item) => `
        <span class="summary-pill">
          <span class="summary-label">${escapeHtml(item.label)}</span>
          <span class="summary-value">${escapeHtml(item.value)}</span>
        </span>
      `,
    )
    .join("");
}

function renderInspector() {
  if (!state.selectedTableId) {
    elements.inspector.innerHTML = `
      <p class="inspector-empty">
        Chọn một bảng trong danh sách hoặc trên sơ đồ để xem chi tiết.
      </p>
    `;
    return;
  }

  const table = state.schema.tableMap.get(state.selectedTableId);
  if (!table) {
    elements.inspector.innerHTML = `
      <p class="inspector-empty">
        Bảng đang chọn không còn hiển thị trong bộ lọc hiện tại.
      </p>
    `;
    return;
  }

  const relatedRelations = (state.schema.relationsByTable.get(table.id) || []).slice().sort((left, right) => {
    return left.name.localeCompare(right.name);
  });
  const primaryKeys = table.columns.filter((column) => column.isPrimaryKey).map((column) => column.name);

  elements.inspector.innerHTML = `
    <h3 class="inspector-title">${escapeHtml(table.name)}</h3>
    <p class="inspector-meta">${escapeHtml(table.schema)} • ${table.columns.length} cột • ${table.relationCount} quan hệ</p>
    <div class="inspector-overview">
      <article class="inspector-stat">
        <span class="stat-label">PK</span>
        <strong>${table.primaryKeyCount || 0}</strong>
      </article>
      <article class="inspector-stat">
        <span class="stat-label">FK</span>
        <strong>${table.foreignKeyCount || 0}</strong>
      </article>
      <article class="inspector-stat">
        <span class="stat-label">Nullable</span>
        <strong>${table.nullableCount || 0}</strong>
      </article>
      <article class="inspector-stat">
        <span class="stat-label">Default</span>
        <strong>${table.defaultCount || 0}</strong>
      </article>
    </div>
    <div class="inspector-highlight">
      <strong>Primary key</strong>
      <div class="detail-meta">${escapeHtml(primaryKeys.length ? primaryKeys.join(", ") : "Không có primary key.")}</div>
    </div>
    <div class="inspector-grid">
      <section class="detail-section">
        <h3>Cột</h3>
        <div class="detail-list">
          ${table.columns
            .map(
              (column) => `
                <div class="detail-item">
                  <div class="detail-name">
                    <span>${escapeHtml(column.name)}</span>
                    <span class="detail-pill-row">
                      ${column.isPrimaryKey ? '<span class="pill pill-pk">PK</span>' : ""}
                      ${column.isForeignKey ? '<span class="pill pill-fk">FK</span>' : ""}
                      ${column.nullable ? '<span class="pill pill-soft">NULL</span>' : '<span class="pill pill-neutral">NN</span>'}
                    </span>
                  </div>
                  <div class="detail-meta">
                    ${escapeHtml(column.dataType)}
                    ${column.nullable ? " • nullable" : " • not null"}
                    ${column.isIdentity ? " • identity" : ""}
                    ${column.hasDefault ? " • default" : ""}
                  </div>
                </div>
              `,
            )
            .join("")}
        </div>
      </section>
      <section class="detail-section">
        <h3>Quan hệ</h3>
        <div class="detail-list">
          ${
            relatedRelations.length
              ? relatedRelations
                  .map((relation) => {
                    const isSource = relation.sourceTableId === table.id;
                    const otherSide = isSource ? relation.target : relation.source;
                    const localColumns = isSource ? relation.source.columns : relation.target.columns;
                    const remoteColumns = isSource ? relation.target.columns : relation.source.columns;
                    const directionLabel = isSource
                      ? `FK tới ${otherSide.table}`
                      : `Được ${otherSide.table} tham chiếu`;
                    const actionSummary = summarizeRelationActions(relation);
                    const directionPill = isSource
                      ? '<span class="pill pill-fk">OUT</span>'
                      : '<span class="pill pill-neutral">IN</span>';

                    return `
                      <div class="detail-item">
                        <div class="detail-name">
                          <span>${escapeHtml(directionLabel)}</span>
                          ${directionPill}
                        </div>
                        <div class="detail-meta">${escapeHtml(relation.name)}</div>
                        <div class="detail-meta">
                          ${escapeHtml(formatCompactRelationColumns(localColumns, otherSide.table, remoteColumns))}
                        </div>
                        <div class="detail-meta">${escapeHtml(actionSummary)}</div>
                      </div>
                    `;
                  })
                  .join("")
              : '<p class="inspector-empty">Bảng này chưa có foreign key nào.</p>'
          }
        </div>
      </section>
    </div>
  `;
}

function buildLayout(tables) {
  if (!tables.length) {
    return {
      tables: new Map(),
      groups: [],
      width: getViewportRect().width,
      height: getViewportRect().height,
    };
  }

  const grouped = new Map();

  for (const table of tables) {
    if (!grouped.has(table.schema)) {
      grouped.set(table.schema, []);
    }

    grouped.get(table.schema).push(table);
  }

  const schemaEntries = [...grouped.entries()].sort(
    (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
  );
  const rowLimit = Math.max(getViewportRect().width + GROUP_GAP_X, 1580);
  const positions = new Map();
  let cursorX = STAGE_PADDING;
  let cursorY = STAGE_PADDING;
  let rowHeight = 0;

  for (const [, schemaTables] of schemaEntries) {
    const cluster = buildSchemaCluster(schemaTables);

    if (cursorX > STAGE_PADDING && cursorX + cluster.width > rowLimit) {
      cursorX = STAGE_PADDING;
      cursorY += rowHeight + GROUP_GAP_Y;
      rowHeight = 0;
    }

    for (const entry of cluster.tables) {
      positions.set(entry.tableId, {
        x: cursorX + entry.x,
        y: cursorY + entry.y,
        width: CARD_WIDTH,
        height: entry.height,
      });
    }

    rowHeight = Math.max(rowHeight, cluster.height);
    cursorX += cluster.width + GROUP_GAP_X;
  }

  for (const table of tables) {
    const manualPosition = state.manualTablePositions.get(table.id);
    const position = positions.get(table.id);

    if (manualPosition && position) {
      position.x = manualPosition.x;
      position.y = manualPosition.y;
    }
  }

  const bounds = computeLayoutBounds(tables, positions);

  return {
    tables: positions,
    groups: bounds.groups,
    width: bounds.width,
    height: bounds.height,
  };
}

function buildSchemaCluster(schemaTables) {
  const sortedTables = schemaTables.slice().sort(
    (left, right) =>
      right.relationCount - left.relationCount ||
      right.columns.length - left.columns.length ||
      left.name.localeCompare(right.name),
  );
  const columns = sortedTables.length >= 4 ? 2 : 1;
  const columnHeights = new Array(columns).fill(0);
  const entries = [];

  for (const table of sortedTables) {
    const height = getCardHeight(table);
    const columnIndex = indexOfSmallest(columnHeights);
    const x = GROUP_FRAME_PADDING + columnIndex * (CARD_WIDTH + GROUP_COLUMN_GAP);
    const y = GROUP_HEADER_HEIGHT + GROUP_FRAME_PADDING + columnHeights[columnIndex];

    entries.push({
      tableId: table.id,
      x,
      y,
      height,
    });

    columnHeights[columnIndex] += height + GROUP_ROW_GAP;
  }

  const contentHeight = Math.max(
    0,
    ...columnHeights.map((value) => {
      return value > 0 ? value - GROUP_ROW_GAP : 0;
    }),
  );

  return {
    width: GROUP_FRAME_PADDING * 2 + columns * CARD_WIDTH + (columns - 1) * GROUP_COLUMN_GAP,
    height: GROUP_HEADER_HEIGHT + GROUP_FRAME_PADDING + contentHeight + GROUP_FRAME_PADDING,
    tables: entries,
  };
}

function computeLayoutBounds(tables, positions) {
  const grouped = new Map();

  for (const table of tables) {
    if (!grouped.has(table.schema)) {
      grouped.set(table.schema, []);
    }

    grouped.get(table.schema).push(table);
  }

  const groups = [];
  const viewport = getViewportRect();
  let maxRight = viewport.width;
  let maxBottom = viewport.height;

  for (const [schema, schemaTables] of grouped.entries()) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;

    for (const table of schemaTables) {
      const position = positions.get(table.id);

      if (!position) {
        continue;
      }

      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x + position.width);
      maxY = Math.max(maxY, position.y + position.height);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      continue;
    }

    const x = Math.max(16, minX - GROUP_FRAME_PADDING);
    const y = Math.max(16, minY - GROUP_HEADER_HEIGHT + 18);
    const width = maxX - minX + GROUP_FRAME_PADDING * 2;
    const height = maxY - minY + GROUP_HEADER_HEIGHT + GROUP_FRAME_EXTRA_BOTTOM - 18;

    groups.push({
      schema,
      x,
      y,
      width,
      height,
      count: schemaTables.length,
    });

    maxRight = Math.max(maxRight, x + width + STAGE_PADDING);
    maxBottom = Math.max(maxBottom, y + height + STAGE_PADDING);
  }

  for (const position of positions.values()) {
    maxRight = Math.max(maxRight, position.x + position.width + STAGE_PADDING);
    maxBottom = Math.max(maxBottom, position.y + position.height + STAGE_PADDING);
  }

  groups.sort((left, right) => left.y - right.y || left.x - right.x || left.schema.localeCompare(right.schema));

  return {
    groups,
    width: maxRight,
    height: maxBottom,
  };
}

function getCardHeight(table) {
  return CARD_HEADER_HEIGHT + table.columns.length * COLUMN_HEIGHT + CARD_BOTTOM_PADDING;
}

function indexOfSmallest(values) {
  let smallestIndex = 0;

  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < values[smallestIndex]) {
      smallestIndex = index;
    }
  }

  return smallestIndex;
}

function renderGraph() {
  const hasData = state.currentTables.length > 0;

  elements.emptyState.hidden = hasData;
  elements.emptyState.innerHTML = state.schema
    ? `
        <h2>Không có bảng nào khớp bộ lọc</h2>
        <p>Thử bật lại schema, xóa từ khóa tìm kiếm hoặc bấm <strong>Căn lại sơ đồ</strong> sau khi kết nối lại database.</p>
      `
    : `
        <h2>Sẵn sàng đọc schema</h2>
        <p>
          Nhập thông tin PostgreSQL ở bên trái, sau đó bấm <strong>Đọc schema</strong> để dựng sơ đồ ERD local.
        </p>
      `;

  applyStageMetrics();
  renderSchemaGroups();
  renderNodesLayer();
  renderEdgesLayer();
}

function applyStageMetrics() {
  elements.stage.style.width = `${state.layout.width}px`;
  elements.stage.style.height = `${state.layout.height}px`;
  elements.edges.setAttribute("width", String(state.layout.width));
  elements.edges.setAttribute("height", String(state.layout.height));
  elements.edges.setAttribute("viewBox", `0 0 ${state.layout.width} ${state.layout.height}`);
}

function renderSchemaGroups() {
  elements.schemas.innerHTML = state.layout.groups
    .map(
      (group) => `
        <section
          class="schema-group"
          style="transform: translate(${group.x}px, ${group.y}px); width: ${group.width}px; height: ${group.height}px;"
        >
          <div class="schema-group-header">
            <span class="schema-group-name">${escapeHtml(group.schema)}</span>
            <span class="schema-group-count">${group.count} bảng</span>
          </div>
        </section>
      `,
    )
    .join("");
}

function renderNodesLayer() {
  elements.nodes.innerHTML = state.currentTables
    .map((table) => renderCard(table, state.layout.tables.get(table.id)))
    .join("");
}

function renderEdgesLayer(mode = getEdgeRenderMode()) {
  const routing = mode === "smart" ? buildRoutingGrid(state.currentTables, state.layout.tables) : null;
  elements.edges.innerHTML = state.currentRelationships.map((relation) => renderEdge(relation, { mode, routing })).join("");
}

function renderCard(table, position) {
  if (!position) {
    return "";
  }

  const columnsMarkup = table.columns
    .map(
      (column) => `
        <div class="erd-column">
          <div class="erd-column-name">
            <span class="column-name-text" title="${escapeAttribute(column.name)}">${escapeHtml(column.name)}</span>
            <span class="erd-column-flags">
              ${column.isPrimaryKey ? '<span class="pill pill-pk">PK</span>' : ""}
              ${column.isForeignKey ? '<span class="pill pill-fk">FK</span>' : ""}
              ${column.nullable ? '<span class="pill pill-soft">NULL</span>' : '<span class="pill pill-neutral">NN</span>'}
              ${column.isIdentity ? '<span class="pill pill-neutral">ID</span>' : ""}
              ${column.hasDefault ? '<span class="pill pill-soft">DEF</span>' : ""}
            </span>
          </div>
          <div class="column-meta" title="${escapeAttribute(column.dataType)}">${escapeHtml(column.dataType)}</div>
        </div>
      `,
    )
    .join("");

  return `
    <article
      class="erd-card ${table.id === state.selectedTableId ? "is-selected" : ""}"
      data-card-table-id="${escapeAttribute(table.id)}"
      style="transform: translate3d(${position.x}px, ${position.y}px, 0);"
    >
      <header class="erd-card-header" data-drag-handle="true" title="Kéo để di chuyển bảng">
        <div class="erd-card-title-row">
          <h3 class="erd-card-title">${escapeHtml(table.name)}</h3>
          <span class="erd-card-type">${escapeHtml(table.type)}</span>
        </div>
        <div class="erd-card-subtitle">
          <span class="schema-tag">${escapeHtml(table.schema)}</span>
          <span class="drag-label">${table.relationCount} rel • kéo</span>
        </div>
        <div class="erd-card-stats">
          <span class="erd-stat-pill">${table.columns.length} cột</span>
          <span class="erd-stat-pill">${table.primaryKeyCount || 0} PK</span>
          <span class="erd-stat-pill">${table.foreignKeyCount || 0} FK</span>
        </div>
      </header>
      <div class="erd-card-columns">${columnsMarkup}</div>
    </article>
  `;
}

function renderEdge(relation, options = {}) {
  const path = computeEdgePath(relation, options);
  if (!path) {
    return "";
  }

  const edgeClasses = getEdgeSelectionState(relation);
  return `
    <path
      class="erd-edge ${edgeClasses.isActive ? "is-active" : ""} ${edgeClasses.isMuted ? "is-muted" : ""}"
      data-edge-id="${escapeAttribute(getRelationKey(relation))}"
      data-source-table-id="${escapeAttribute(relation.sourceTableId)}"
      data-target-table-id="${escapeAttribute(relation.targetTableId)}"
      d="${path}"
    >
      <title>${escapeHtml(`${relation.name}: ${relation.sourceTableId} -> ${relation.targetTableId}`)}</title>
    </path>
  `;
}

function computeEdgePath(relation, options = {}) {
  const sourcePosition = state.layout.tables.get(relation.sourceTableId);
  const targetPosition = state.layout.tables.get(relation.targetTableId);

  if (!sourcePosition || !targetPosition) {
    return "";
  }

  const sourceTable = state.schema.tableMap.get(relation.sourceTableId);
  const targetTable = state.schema.tableMap.get(relation.targetTableId);
  const sourceColumnIndex = averageColumnIndex(sourceTable, relation.source.columns);
  const targetColumnIndex = averageColumnIndex(targetTable, relation.target.columns);
  const sourceColumnY = sourcePosition.y + CARD_HEADER_HEIGHT + sourceColumnIndex * COLUMN_HEIGHT + COLUMN_HEIGHT / 2;
  const targetColumnY = targetPosition.y + CARD_HEADER_HEIGHT + targetColumnIndex * COLUMN_HEIGHT + COLUMN_HEIGHT / 2;
  const sides = chooseEdgeSides(sourcePosition, targetPosition);

  if (options.mode !== "smart") {
    return buildFastEdgePath(sourcePosition, targetPosition, sides, sourceColumnY, targetColumnY);
  }

  const routing = options.routing || buildRoutingGrid(state.currentTables, state.layout.tables);
  const sourceEndpoint = buildEdgeEndpoint(sourcePosition, sides.source, sourceColumnY, routing);
  const targetEndpoint = buildEdgeEndpoint(targetPosition, sides.target, targetColumnY, routing);
  const freeCells = new Set([
    getRoutingCellKey(routing, sourceEndpoint.anchorCell.col, sourceEndpoint.anchorCell.row),
    getRoutingCellKey(routing, targetEndpoint.anchorCell.col, targetEndpoint.anchorCell.row),
  ]);
  const routeCells = findGridRoute(sourceEndpoint.anchorCell, targetEndpoint.anchorCell, routing, freeCells);
  const routePoints = routeCells
    ? routeCells.slice(1, -1).map((cell) => getRoutingCellCenter(routing, cell.col, cell.row))
    : buildFallbackRoutePoints(sourceEndpoint.anchor, targetEndpoint.anchor);
  const points = simplifyOrthogonalPoints([
    sourceEndpoint.port,
    sourceEndpoint.bridge,
    sourceEndpoint.anchor,
    ...routePoints,
    targetEndpoint.anchor,
    targetEndpoint.bridge,
    targetEndpoint.port,
  ]);

  return buildSmoothPath(points);
}

function buildFastEdgePath(sourcePosition, targetPosition, sides, sourceColumnY, targetColumnY) {
  const sourcePort = buildPortPoint(sourcePosition, sides.source, sourceColumnY);
  const targetPort = buildPortPoint(targetPosition, sides.target, targetColumnY);
  const sourceBridge = buildBridgePoint(sourcePort, sides.source, LIVE_EDGE_PORT_OFFSET);
  const targetBridge = buildBridgePoint(targetPort, sides.target, LIVE_EDGE_PORT_OFFSET);
  let routePoints;

  if (isHorizontalSide(sides.source) && isHorizontalSide(sides.target)) {
    const middleX = Math.round((sourceBridge.x + targetBridge.x) / 2);
    routePoints = [
      { x: middleX, y: sourceBridge.y },
      { x: middleX, y: targetBridge.y },
    ];
  } else if (!isHorizontalSide(sides.source) && !isHorizontalSide(sides.target)) {
    const middleY = Math.round((sourceBridge.y + targetBridge.y) / 2);
    routePoints = [
      { x: sourceBridge.x, y: middleY },
      { x: targetBridge.x, y: middleY },
    ];
  } else {
    routePoints = buildFallbackRoutePoints(sourceBridge, targetBridge);
  }

  const points = simplifyOrthogonalPoints([sourcePort, sourceBridge, ...routePoints, targetBridge, targetPort]);
  return buildSmoothPath(points);
}

function buildPortPoint(position, side, preferredY) {
  const minY = position.y + 18;
  const maxY = position.y + position.height - 18;
  const clampedY = clamp(preferredY, minY, maxY);

  if (side === "left") {
    return { x: position.x, y: clampedY };
  }

  if (side === "right") {
    return { x: position.x + position.width, y: clampedY };
  }

  if (side === "top") {
    return { x: position.x + position.width / 2, y: position.y };
  }

  return { x: position.x + position.width / 2, y: position.y + position.height };
}

function buildBridgePoint(port, side, offset) {
  if (side === "left") {
    return { x: port.x - offset, y: port.y };
  }

  if (side === "right") {
    return { x: port.x + offset, y: port.y };
  }

  if (side === "top") {
    return { x: port.x, y: port.y - offset };
  }

  return { x: port.x, y: port.y + offset };
}

function isHorizontalSide(side) {
  return side === "left" || side === "right";
}

function getRelationKey(relation) {
  return [
    relation.name,
    relation.sourceTableId,
    relation.source.columns.join(","),
    relation.targetTableId,
    relation.target.columns.join(","),
  ].join("|");
}

function getEdgeSelectionState(relation) {
  const isActive =
    state.selectedTableId &&
    (relation.sourceTableId === state.selectedTableId || relation.targetTableId === state.selectedTableId);

  return {
    isActive,
    isMuted: Boolean(state.selectedTableId && !isActive),
  };
}

function averageColumnIndex(table, columnNames) {
  if (!table || !Array.isArray(columnNames) || columnNames.length === 0) {
    return 0;
  }

  const positions = columnNames
    .map((columnName) => table.columns.findIndex((column) => column.name === columnName))
    .filter((index) => index >= 0);

  if (!positions.length) {
    return 0;
  }

  const sum = positions.reduce((total, value) => total + value, 0);
  return sum / positions.length;
}

function moveTable(tableId, x, y, deltaX = 0, deltaY = 0) {
  const position = state.layout.tables.get(tableId);
  if (!position) {
    return;
  }

  const proposed = {
    x: Math.round(Math.max(24, x)),
    y: Math.round(Math.max(24, y)),
    width: position.width,
    height: position.height,
  };
  const resolved = resolveDraggedTablePosition(tableId, proposed, deltaX, deltaY) || {
    x: position.x,
    y: position.y,
    width: position.width,
    height: position.height,
  };

  position.x = resolved.x;
  position.y = resolved.y;
  state.manualTablePositions.set(tableId, { x: resolved.x, y: resolved.y });

  const card = findCardElement(tableId);
  if (card) {
    card.style.transform = `translate3d(${resolved.x}px, ${resolved.y}px, 0)`;
  }

  scheduleDragLayoutUpdate(tableId);
}

function isTableSlotFree(tableId, candidate) {
  for (const [otherTableId, otherPosition] of state.layout.tables.entries()) {
    if (otherTableId === tableId) {
      continue;
    }

    if (rectanglesOverlap(candidate, otherPosition, TABLE_COLLISION_GAP)) {
      return false;
    }
  }

  return true;
}

function resolveDraggedTablePosition(tableId, candidate, deltaX, deltaY) {
  const current = {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  };

  if (isTableSlotFree(tableId, current)) {
    return current;
  }

  const preferHorizontal = Math.abs(deltaX) >= Math.abs(deltaY);
  const attempts = preferHorizontal
    ? [
        { x: current.x, y: state.layout.tables.get(tableId).y, width: current.width, height: current.height },
        { x: state.layout.tables.get(tableId).x, y: current.y, width: current.width, height: current.height },
      ]
    : [
        { x: state.layout.tables.get(tableId).x, y: current.y, width: current.width, height: current.height },
        { x: current.x, y: state.layout.tables.get(tableId).y, width: current.width, height: current.height },
      ];

  for (const attempt of attempts) {
    const pushed = pushCandidateOutOfCollisions(tableId, attempt, deltaX, deltaY);
    if (pushed && isTableSlotFree(tableId, pushed)) {
      return pushed;
    }
  }

  const pushed = pushCandidateOutOfCollisions(tableId, current, deltaX, deltaY);
  if (pushed && isTableSlotFree(tableId, pushed)) {
    return pushed;
  }

  return null;
}

function pushCandidateOutOfCollisions(tableId, candidate, deltaX, deltaY) {
  const resolved = { ...candidate };
  const preferHorizontal = Math.abs(deltaX) >= Math.abs(deltaY);

  for (let iteration = 0; iteration < 6; iteration += 1) {
    let adjusted = false;

    for (const [otherTableId, otherPosition] of state.layout.tables.entries()) {
      if (otherTableId === tableId) {
        continue;
      }

      if (!rectanglesOverlap(resolved, otherPosition, TABLE_COLLISION_GAP)) {
        continue;
      }

      adjusted = true;

      if (preferHorizontal) {
        if (deltaX >= 0) {
          resolved.x = otherPosition.x - resolved.width - TABLE_COLLISION_GAP;
        } else {
          resolved.x = otherPosition.x + otherPosition.width + TABLE_COLLISION_GAP;
        }
      } else if (deltaY >= 0) {
        resolved.y = otherPosition.y - resolved.height - TABLE_COLLISION_GAP;
      } else {
        resolved.y = otherPosition.y + otherPosition.height + TABLE_COLLISION_GAP;
      }
    }

    if (!adjusted) {
      resolved.x = Math.max(24, Math.round(resolved.x));
      resolved.y = Math.max(24, Math.round(resolved.y));
      return resolved;
    }
  }

  return null;
}

function scheduleDragLayoutUpdate(tableId) {
  state.dragFrameTableId = tableId || state.dragFrameTableId;

  if (state.dragFrameRequested) {
    return;
  }

  state.dragFrameRequested = true;
  window.requestAnimationFrame(() => {
    const activeTableId = state.dragFrameTableId;

    state.dragFrameRequested = false;
    state.dragFrameTableId = null;
    flushDragLayout(activeTableId);
  });
}

function flushDragLayout(liveTableId = null) {
  const bounds = computeLayoutBounds(state.currentTables, state.layout.tables);
  state.layout.groups = bounds.groups;
  state.layout.width = bounds.width;
  state.layout.height = bounds.height;
  applyStageMetrics();
  renderSchemaGroups();

  if (liveTableId && state.drag) {
    updateLiveEdgesForTable(liveTableId);
    return;
  }

  renderEdgesLayer();
}

function rectanglesOverlap(leftRect, rightRect, gap) {
  return !(
    leftRect.x + leftRect.width + gap <= rightRect.x ||
    rightRect.x + rightRect.width + gap <= leftRect.x ||
    leftRect.y + leftRect.height + gap <= rightRect.y ||
    rightRect.y + rightRect.height + gap <= leftRect.y
  );
}

function buildRoutingGrid(tables, positions) {
  const cols = Math.max(1, Math.ceil(state.layout.width / EDGE_GRID_SIZE) + 2);
  const rows = Math.max(1, Math.ceil(state.layout.height / EDGE_GRID_SIZE) + 2);
  const blocked = new Uint8Array(cols * rows);

  for (const table of tables) {
    const position = positions.get(table.id);
    if (!position) {
      continue;
    }

    const left = Math.max(0, position.x - EDGE_CLEARANCE);
    const top = Math.max(0, position.y - EDGE_CLEARANCE);
    const right = position.x + position.width + EDGE_CLEARANCE;
    const bottom = position.y + position.height + EDGE_CLEARANCE;
    const startCol = clamp(Math.floor(left / EDGE_GRID_SIZE), 0, cols - 1);
    const endCol = clamp(Math.floor(right / EDGE_GRID_SIZE), 0, cols - 1);
    const startRow = clamp(Math.floor(top / EDGE_GRID_SIZE), 0, rows - 1);
    const endRow = clamp(Math.floor(bottom / EDGE_GRID_SIZE), 0, rows - 1);

    for (let row = startRow; row <= endRow; row += 1) {
      for (let col = startCol; col <= endCol; col += 1) {
        blocked[getRoutingCellKey({ cols }, col, row)] = 1;
      }
    }
  }

  return {
    size: EDGE_GRID_SIZE,
    cols,
    rows,
    blocked,
  };
}

function chooseEdgeSides(sourcePosition, targetPosition) {
  const sourceCenterX = sourcePosition.x + sourcePosition.width / 2;
  const sourceCenterY = sourcePosition.y + sourcePosition.height / 2;
  const targetCenterX = targetPosition.x + targetPosition.width / 2;
  const targetCenterY = targetPosition.y + targetPosition.height / 2;
  const deltaX = targetCenterX - sourceCenterX;
  const deltaY = targetCenterY - sourceCenterY;

  if (Math.abs(deltaX) >= Math.abs(deltaY) * 0.9) {
    return deltaX >= 0
      ? { source: "right", target: "left" }
      : { source: "left", target: "right" };
  }

  return deltaY >= 0
    ? { source: "bottom", target: "top" }
    : { source: "top", target: "bottom" };
}

function buildEdgeEndpoint(position, side, preferredY, routing) {
  const minY = position.y + 18;
  const maxY = position.y + position.height - 18;
  const clampedY = clamp(preferredY, minY, maxY);
  let port;
  let bridge;
  let anchorCell;

  if (side === "left") {
    port = { x: position.x, y: clampedY };
    anchorCell = snapAnchorCell(routing, position.x - EDGE_PORT_OFFSET, clampedY, "left");
  } else if (side === "right") {
    port = { x: position.x + position.width, y: clampedY };
    anchorCell = snapAnchorCell(routing, position.x + position.width + EDGE_PORT_OFFSET, clampedY, "right");
  } else if (side === "top") {
    port = { x: position.x + position.width / 2, y: position.y };
    anchorCell = snapAnchorCell(routing, port.x, position.y - EDGE_PORT_OFFSET, "top");
  } else {
    port = { x: position.x + position.width / 2, y: position.y + position.height };
    anchorCell = snapAnchorCell(routing, port.x, position.y + position.height + EDGE_PORT_OFFSET, "bottom");
  }

  const anchor = getRoutingCellCenter(routing, anchorCell.col, anchorCell.row);

  if (side === "left" || side === "right") {
    bridge = { x: anchor.x, y: port.y };
  } else {
    bridge = { x: port.x, y: anchor.y };
  }

  return {
    side,
    port,
    bridge,
    anchor,
    anchorCell,
  };
}

function snapAnchorCell(routing, x, y, side) {
  const rawCol = x / routing.size - 0.5;
  const rawRow = y / routing.size - 0.5;
  let col = Math.round(rawCol);
  let row = Math.round(rawRow);

  if (side === "left") {
    col = Math.floor(rawCol);
  } else if (side === "right") {
    col = Math.ceil(rawCol);
  } else if (side === "top") {
    row = Math.floor(rawRow);
  } else if (side === "bottom") {
    row = Math.ceil(rawRow);
  }

  return {
    col: clamp(col, 0, routing.cols - 1),
    row: clamp(row, 0, routing.rows - 1),
  };
}

function findGridRoute(startCell, endCell, routing, freeCells) {
  const startKey = getRoutingCellKey(routing, startCell.col, startCell.row);
  const endKey = getRoutingCellKey(routing, endCell.col, endCell.row);
  const open = [startCell];
  const openKeys = new Set([startKey]);
  const cameFrom = new Map();
  const gScore = new Map([[startKey, 0]]);
  const fScore = new Map([[startKey, gridHeuristic(startCell, endCell)]]);
  const directions = buildDirectionPriority(startCell, endCell);
  const maxIterations = routing.cols * routing.rows * 4;
  let iterations = 0;

  while (open.length && iterations < maxIterations) {
    iterations += 1;
    let bestIndex = 0;

    for (let index = 1; index < open.length; index += 1) {
      const bestNode = open[bestIndex];
      const node = open[index];
      const bestKey = getRoutingCellKey(routing, bestNode.col, bestNode.row);
      const nodeKey = getRoutingCellKey(routing, node.col, node.row);

      if ((fScore.get(nodeKey) ?? Infinity) < (fScore.get(bestKey) ?? Infinity)) {
        bestIndex = index;
      }
    }

    const current = open.splice(bestIndex, 1)[0];
    const currentKey = getRoutingCellKey(routing, current.col, current.row);
    openKeys.delete(currentKey);

    if (currentKey === endKey) {
      return reconstructGridRoute(cameFrom, currentKey, routing);
    }

    for (const direction of directions) {
      const nextCol = current.col + direction.col;
      const nextRow = current.row + direction.row;

      if (!isRoutingCellWalkable(routing, nextCol, nextRow, freeCells)) {
        continue;
      }

      const nextKey = getRoutingCellKey(routing, nextCol, nextRow);
      const tentativeScore = (gScore.get(currentKey) ?? Infinity) + 1;

      if (tentativeScore >= (gScore.get(nextKey) ?? Infinity)) {
        continue;
      }

      cameFrom.set(nextKey, currentKey);
      gScore.set(nextKey, tentativeScore);
      fScore.set(nextKey, tentativeScore + gridHeuristic({ col: nextCol, row: nextRow }, endCell));

      if (!openKeys.has(nextKey)) {
        open.push({ col: nextCol, row: nextRow });
        openKeys.add(nextKey);
      }
    }
  }

  return null;
}

function buildDirectionPriority(startCell, endCell) {
  const horizontal = endCell.col >= startCell.col ? { col: 1, row: 0 } : { col: -1, row: 0 };
  const reverseHorizontal = { col: -horizontal.col, row: 0 };
  const vertical = endCell.row >= startCell.row ? { col: 0, row: 1 } : { col: 0, row: -1 };
  const reverseVertical = { col: 0, row: -vertical.row };

  return [horizontal, vertical, reverseHorizontal, reverseVertical];
}

function isRoutingCellWalkable(routing, col, row, freeCells) {
  if (col < 0 || row < 0 || col >= routing.cols || row >= routing.rows) {
    return false;
  }

  const key = getRoutingCellKey(routing, col, row);
  return freeCells.has(key) || routing.blocked[key] === 0;
}

function reconstructGridRoute(cameFrom, endKey, routing) {
  const path = [];
  let currentKey = endKey;

  while (currentKey !== undefined) {
    path.push(getRoutingCellFromKey(routing, currentKey));
    currentKey = cameFrom.get(currentKey);
  }

  path.reverse();
  return path;
}

function gridHeuristic(leftCell, rightCell) {
  return Math.abs(leftCell.col - rightCell.col) + Math.abs(leftCell.row - rightCell.row);
}

function buildPathFromPoints(points) {
  if (!points.length) {
    return "";
  }

  const [firstPoint, ...restPoints] = points;
  return `M ${firstPoint.x} ${firstPoint.y}` + restPoints.map((point) => ` L ${point.x} ${point.y}`).join("");
}

function buildSmoothPath(points) {
  if (!points.length) {
    return "";
  }

  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const previousPoint = points[index - 1];
    const currentPoint = points[index];
    const nextPoint = points[index + 1];
    const startCorner = movePointToward(currentPoint, previousPoint, EDGE_CORNER_RADIUS);
    const endCorner = movePointToward(currentPoint, nextPoint, EDGE_CORNER_RADIUS);

    path += ` L ${startCorner.x} ${startCorner.y}`;
    path += ` Q ${currentPoint.x} ${currentPoint.y} ${endCorner.x} ${endCorner.y}`;
  }

  const lastPoint = points[points.length - 1];
  path += ` L ${lastPoint.x} ${lastPoint.y}`;

  return path;
}

function buildFallbackRoutePoints(sourceAnchor, targetAnchor) {
  if (Math.abs(sourceAnchor.x - targetAnchor.x) >= Math.abs(sourceAnchor.y - targetAnchor.y)) {
    return [{ x: targetAnchor.x, y: sourceAnchor.y }];
  }

  return [{ x: sourceAnchor.x, y: targetAnchor.y }];
}

function simplifyOrthogonalPoints(points) {
  const simplified = [];

  for (const rawPoint of points) {
    const point = {
      x: Math.round(rawPoint.x),
      y: Math.round(rawPoint.y),
    };

    if (!simplified.length) {
      simplified.push(point);
      continue;
    }

    const lastPoint = simplified[simplified.length - 1];
    if (lastPoint.x === point.x && lastPoint.y === point.y) {
      continue;
    }

    if (simplified.length >= 2) {
      const previousPoint = simplified[simplified.length - 2];
      const sameVerticalLine = previousPoint.x === lastPoint.x && lastPoint.x === point.x;
      const sameHorizontalLine = previousPoint.y === lastPoint.y && lastPoint.y === point.y;

      if (sameVerticalLine || sameHorizontalLine) {
        simplified[simplified.length - 1] = point;
        continue;
      }
    }

    simplified.push(point);
  }

  return simplified;
}

function movePointToward(fromPoint, towardPoint, distanceLimit) {
  const deltaX = towardPoint.x - fromPoint.x;
  const deltaY = towardPoint.y - fromPoint.y;
  const distance = Math.abs(deltaX) + Math.abs(deltaY);
  const distanceToUse = Math.min(distanceLimit, distance / 2);

  if (deltaX !== 0) {
    return {
      x: fromPoint.x + Math.sign(deltaX) * distanceToUse,
      y: fromPoint.y,
    };
  }

  return {
    x: fromPoint.x,
    y: fromPoint.y + Math.sign(deltaY) * distanceToUse,
  };
}

function formatCompactRelationColumns(localColumns, remoteTable, remoteColumns) {
  if (localColumns.length === 1 && remoteColumns.length === 1) {
    return `${localColumns[0]} -> ${remoteTable}.${remoteColumns[0]}`;
  }

  return `(${localColumns.join(", ")}) -> ${remoteTable}(${remoteColumns.join(", ")})`;
}

function summarizeRelationActions(relation) {
  const actionParts = [];

  if (relation.onDelete !== "NO ACTION") {
    actionParts.push(`xóa ${normalizeRelationAction(relation.onDelete)}`);
  }

  if (relation.onUpdate !== "NO ACTION") {
    actionParts.push(`cập nhật ${normalizeRelationAction(relation.onUpdate)}`);
  }

  if (!actionParts.length) {
    return "ràng buộc mặc định";
  }

  return actionParts.join(" • ");
}

function normalizeRelationAction(action) {
  switch (action) {
    case "CASCADE":
      return "lan truyền";
    case "SET NULL":
      return "set null";
    case "SET DEFAULT":
      return "set mặc định";
    case "RESTRICT":
      return "chặn";
    default:
      return action.toLowerCase();
  }
}

function getRoutingCellKey(routing, col, row) {
  return row * routing.cols + col;
}

function getRoutingCellFromKey(routing, key) {
  return {
    col: key % routing.cols,
    row: Math.floor(key / routing.cols),
  };
}

function getRoutingCellCenter(routing, col, row) {
  return {
    x: (col + 0.5) * routing.size,
    y: (row + 0.5) * routing.size,
  };
}

function getEdgeRenderMode() {
  if (
    state.currentRelationships.length >= FAST_EDGE_RELATION_THRESHOLD ||
    state.currentTables.length >= FAST_EDGE_TABLE_THRESHOLD
  ) {
    return "fast";
  }

  return "smart";
}

function updateCardSelectionClasses() {
  const cards = elements.nodes.querySelectorAll(".erd-card");

  for (const card of cards) {
    const tableId = card.getAttribute("data-card-table-id");
    card.classList.toggle("is-selected", tableId === state.selectedTableId);
  }
}

function updateTableListSelectionClasses() {
  const items = elements.tableList.querySelectorAll(".table-list-item");

  for (const item of items) {
    const tableId = item.getAttribute("data-table-id");
    item.classList.toggle("is-selected", tableId === state.selectedTableId);
  }
}

function updateEdgeSelectionClasses() {
  const edges = elements.edges.querySelectorAll(".erd-edge");

  for (const edge of edges) {
    const sourceTableId = edge.getAttribute("data-source-table-id");
    const targetTableId = edge.getAttribute("data-target-table-id");
    const isActive =
      Boolean(state.selectedTableId) &&
      (sourceTableId === state.selectedTableId || targetTableId === state.selectedTableId);

    edge.classList.toggle("is-active", isActive);
    edge.classList.toggle("is-muted", Boolean(state.selectedTableId && !isActive));
  }
}

function updateSelectionUI() {
  updateCardSelectionClasses();
  updateTableListSelectionClasses();
  renderWorkspaceHeader();
  renderWorkspaceSummary();
  renderInspector();
  updateEdgeSelectionClasses();
}

function findCardElement(tableId) {
  return elements.nodes.querySelector(`[data-card-table-id="${escapeSelectorValue(tableId)}"]`);
}

function findEdgeElement(relationKey) {
  return elements.edges.querySelector(`[data-edge-id="${escapeSelectorValue(relationKey)}"]`);
}

function getVisibleRelationsForTable(tableId) {
  if (!state.schema) {
    return [];
  }

  return (state.schema.relationsByTable.get(tableId) || []).filter(
    (relation) => state.visibleTableIds.has(relation.sourceTableId) && state.visibleTableIds.has(relation.targetTableId),
  );
}

function updateLiveEdgesForTable(tableId) {
  for (const relation of getVisibleRelationsForTable(tableId)) {
    const edge = findEdgeElement(getRelationKey(relation));
    if (!edge) {
      continue;
    }

    const path = computeEdgePath(relation, { mode: "fast" });
    if (path) {
      edge.setAttribute("d", path);
    }
  }

  updateEdgeSelectionClasses();
}

function selectTable(tableId, options) {
  if (!state.schema) {
    return;
  }

  const didChange = state.selectedTableId !== tableId;
  state.selectedTableId = tableId;

  if (didChange) {
    updateSelectionUI();
  }

  if (options && options.center) {
    centerTable(tableId);
  }
}

function centerTable(tableId) {
  const tablePosition = state.layout.tables.get(tableId);
  if (!tablePosition) {
    return;
  }

  const viewport = getViewportRect();
  const scale = Math.max(state.view.scale, 0.85);
  const targetX = viewport.width / 2 - (tablePosition.x + tablePosition.width / 2) * scale;
  const targetY = viewport.height / 2 - (tablePosition.y + tablePosition.height / 2) * scale;

  state.view.scale = scale;
  state.view.x = targetX;
  state.view.y = targetY;
  applyViewport();
}

function fitToViewport() {
  if (!state.currentTables.length) {
    return;
  }

  const viewport = getViewportRect();
  const margin = 120;
  const contentWidth = Math.max(state.layout.width, 1);
  const contentHeight = Math.max(state.layout.height, 1);
  const scale = clamp(
    Math.min((viewport.width - margin) / contentWidth, (viewport.height - margin) / contentHeight),
    0.35,
    1.05,
  );

  state.view.scale = scale;
  state.view.x = (viewport.width - contentWidth * scale) / 2;
  state.view.y = (viewport.height - contentHeight * scale) / 2;
  applyViewport();
}

function resetViewport() {
  state.view.x = 72;
  state.view.y = 72;
  state.view.scale = 1;
  applyViewport();
}

function applyViewport() {
  elements.stage.style.transform = `translate3d(${state.view.x}px, ${state.view.y}px, 0) scale(${state.view.scale})`;
}

function isSchemaVisible(schemaName) {
  return state.activeSchemas.has(schemaName);
}

function getViewportRect() {
  const rect = elements.viewport.getBoundingClientRect();

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width || elements.viewport.clientWidth || 1200,
    height: rect.height || elements.viewport.clientHeight || 720,
  };
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function escapeSelectorValue(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
