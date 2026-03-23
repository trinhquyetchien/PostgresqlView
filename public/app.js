"use strict";

const STORAGE_KEY = "postgresql-view.connection";
const CARD_WIDTH = 320;
const CARD_HEADER_HEIGHT = 72;
const COLUMN_HEIGHT = 30;
const COLUMN_GAP = 96;
const ROW_GAP = 32;
const GROUP_LABEL_HEIGHT = 52;
const GROUP_TOP_PADDING = 84;

const state = {
  schema: null,
  search: "",
  selectedTableId: null,
  activeSchemas: new Set(),
  visibleTableIds: new Set(),
  currentTables: [],
  currentRelationships: [],
  layout: {
    tables: new Map(),
    groups: [],
    width: 0,
    height: 0,
  },
  view: {
    x: 64,
    y: 64,
    scale: 1,
  },
  pan: null,
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
  fitButton: document.querySelector("#fit-button"),
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
  elements.fitButton.addEventListener("click", fitToViewport);
  elements.resetButton.addEventListener("click", resetViewport);
  elements.tableList.addEventListener("click", handleTableListClick);
  elements.schemaFilters.addEventListener("click", handleSchemaFilterClick);
  elements.nodes.addEventListener("click", handleNodeClick);
  elements.viewport.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
  elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("resize", () => {
    if (state.schema) {
      applyViewport();
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

function handleSearchInput(event) {
  state.search = event.target.value.trim().toLowerCase();
  render();
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

function handleNodeClick(event) {
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
  if (event.button !== 0) {
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

  const rect = elements.viewport.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const factor = event.deltaY < 0 ? 1.08 : 0.92;
  const nextScale = clamp(state.view.scale * factor, 0.35, 1.6);
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
      const key = `${relation.sourceTableId}:${columnName}`;
      foreignKeyMap.set(key, true);
    }

    linkRelation(relationsByTable, relation.sourceTableId, relation);
    linkRelation(relationsByTable, relation.targetTableId, relation);
  }

  const tables = schema.tables.map((table) => ({
    ...table,
    columns: table.columns.map((column) => ({
      ...column,
      isForeignKey: foreignKeyMap.has(`${table.id}:${column.name}`),
    })),
    relationCount: (relationsByTable.get(table.id) || []).length,
  }));

  const schemas = [...new Set(tables.map((table) => table.schema))].sort((a, b) => a.localeCompare(b));

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

  const visibleTableIds = computeVisibleTableIds();
  state.visibleTableIds = visibleTableIds;
  state.currentTables = state.schema.tables.filter((table) => visibleTableIds.has(table.id));
  state.currentRelationships = state.schema.relationships.filter(
    (relation) => visibleTableIds.has(relation.sourceTableId) && visibleTableIds.has(relation.targetTableId),
  );

  if (state.selectedTableId && !visibleTableIds.has(state.selectedTableId)) {
    state.selectedTableId = state.currentTables[0] ? state.currentTables[0].id : null;
  }

  state.layout = buildLayout(state.currentTables);

  renderStats();
  renderSchemaFilters();
  renderTableList();
  renderWorkspaceHeader();
  renderInspector();
  renderGraph();
  applyViewport();
}

function renderDisconnectedState() {
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
  elements.inspector.innerHTML = `
    <p class="inspector-empty">
      Chọn một bảng để xem cột, kiểu dữ liệu và các quan hệ liên quan.
    </p>
  `;
  elements.schemas.innerHTML = "";
  elements.nodes.innerHTML = "";
  elements.edges.innerHTML = "";
}

function computeVisibleTableIds() {
  if (!state.schema) {
    return new Set();
  }

  const visibleIds = new Set();
  const hasSearch = Boolean(state.search);

  for (const table of state.schema.tables) {
    const schemaAllowed = isSchemaVisible(table.schema);

    if (!schemaAllowed) {
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
  const haystacks = [
    table.schema,
    table.name,
    `${table.schema}.${table.name}`,
    ...table.columns.map((column) => `${column.name} ${column.dataType}`),
  ];

  return haystacks.some((value) => value.toLowerCase().includes(search));
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
  const allActive =
    state.activeSchemas.size === 0 || state.schema.schemas.every((schema) => state.activeSchemas.has(schema));

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
          <div class="table-meta">${escapeHtml(table.schema)} • ${table.columns.length} cột</div>
        </button>
      `,
    )
    .join("");
}

function renderWorkspaceHeader() {
  const generatedAt = formatDate(state.schema.generatedAt);
  elements.workspaceTitle.textContent = `Sơ đồ schema • ${state.schema.database}`;
  elements.workspaceMeta.textContent = `${state.currentTables.length} bảng hiển thị • ${state.currentRelationships.length} quan hệ • cập nhật ${generatedAt}`;
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
  const relatedRelations = (state.schema.relationsByTable.get(table.id) || []).slice().sort((left, right) => {
    return left.name.localeCompare(right.name);
  });

  elements.inspector.innerHTML = `
    <h3 class="inspector-title">${escapeHtml(table.name)}</h3>
    <p class="inspector-meta">${escapeHtml(table.schema)} • ${table.columns.length} cột • ${table.relationCount} quan hệ</p>
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
                    ${column.isPrimaryKey ? '<span class="pill pill-pk">PK</span>' : ""}
                    ${column.isForeignKey ? '<span class="pill pill-fk">FK</span>' : ""}
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

                    return `
                      <div class="detail-item">
                        <div class="detail-name">${escapeHtml(relation.name)}</div>
                        <div class="detail-meta">
                          ${escapeHtml(localColumns.join(", "))} → ${escapeHtml(otherSide.schema)}.${escapeHtml(otherSide.table)} (${escapeHtml(remoteColumns.join(", "))})
                        </div>
                        <div class="detail-meta">on update ${escapeHtml(relation.onUpdate)} • on delete ${escapeHtml(relation.onDelete)}</div>
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
  const grouped = new Map();

  for (const table of tables) {
    if (!grouped.has(table.schema)) {
      grouped.set(table.schema, []);
    }

    grouped.get(table.schema).push(table);
  }

  const orderedSchemas = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const tableLayout = new Map();
  const groups = [];
  let maxHeight = 0;

  orderedSchemas.forEach((schema, columnIndex) => {
    const schemaTables = grouped.get(schema).slice().sort((a, b) => a.name.localeCompare(b.name));
    const x = 48 + columnIndex * (CARD_WIDTH + COLUMN_GAP);
    let y = GROUP_TOP_PADDING;

    for (const table of schemaTables) {
      const height = CARD_HEADER_HEIGHT + table.columns.length * COLUMN_HEIGHT + 18;
      tableLayout.set(table.id, {
        x,
        y,
        width: CARD_WIDTH,
        height,
      });
      y += height + ROW_GAP;
    }

    groups.push({
      schema,
      x,
      y: 18,
      width: CARD_WIDTH,
    });
    maxHeight = Math.max(maxHeight, y);
  });

  return {
    tables: tableLayout,
    groups,
    width: Math.max(orderedSchemas.length * (CARD_WIDTH + COLUMN_GAP) + 120, elements.viewport.clientWidth),
    height: Math.max(maxHeight + GROUP_LABEL_HEIGHT, elements.viewport.clientHeight),
  };
}

function renderGraph() {
  const hasData = state.currentTables.length > 0;
  elements.emptyState.hidden = hasData;
  elements.emptyState.innerHTML = state.schema
    ? `
        <h2>Không có bảng nào khớp bộ lọc</h2>
        <p>Thử bật lại schema, xóa từ khóa tìm kiếm hoặc kết nối sang database khác.</p>
      `
    : `
        <h2>Sẵn sàng đọc schema</h2>
        <p>
          Nhập thông tin PostgreSQL ở bên trái, sau đó bấm <strong>Đọc schema</strong> để dựng sơ đồ ERD local.
        </p>
      `;
  elements.stage.style.width = `${state.layout.width}px`;
  elements.stage.style.height = `${state.layout.height}px`;
  elements.edges.setAttribute("width", String(state.layout.width));
  elements.edges.setAttribute("height", String(state.layout.height));
  elements.edges.setAttribute("viewBox", `0 0 ${state.layout.width} ${state.layout.height}`);

  elements.schemas.innerHTML = state.layout.groups
    .map(
      (group) => `
        <div class="schema-block" style="transform: translate(${group.x}px, ${group.y}px); width: ${group.width}px;">
          ${escapeHtml(group.schema)}
        </div>
      `,
    )
    .join("");

  elements.nodes.innerHTML = state.currentTables
    .map((table) => renderCard(table, state.layout.tables.get(table.id)))
    .join("");

  elements.edges.innerHTML = state.currentRelationships.map(renderEdge).join("");
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
            <span>${escapeHtml(column.name)}</span>
            <span class="erd-column-flags">
              ${column.isPrimaryKey ? '<span class="pill pill-pk">PK</span>' : ""}
              ${column.isForeignKey ? '<span class="pill pill-fk">FK</span>' : ""}
            </span>
          </div>
          <div class="column-meta">${escapeHtml(column.dataType)}</div>
        </div>
      `,
    )
    .join("");

  return `
    <article
      class="erd-card ${table.id === state.selectedTableId ? "is-selected" : ""}"
      data-card-table-id="${escapeAttribute(table.id)}"
      style="transform: translate(${position.x}px, ${position.y}px);"
    >
      <header class="erd-card-header">
        <div class="erd-card-title-row">
          <h3 class="erd-card-title">${escapeHtml(table.name)}</h3>
          <span class="erd-card-type">${escapeHtml(table.type)}</span>
        </div>
        <div class="schema-tag">${escapeHtml(table.schema)}</div>
      </header>
      <div class="erd-card-columns">${columnsMarkup}</div>
    </article>
  `;
}

function renderEdge(relation) {
  const sourcePosition = state.layout.tables.get(relation.sourceTableId);
  const targetPosition = state.layout.tables.get(relation.targetTableId);

  if (!sourcePosition || !targetPosition) {
    return "";
  }

  const sourceTable = state.schema.tableMap.get(relation.sourceTableId);
  const targetTable = state.schema.tableMap.get(relation.targetTableId);
  const sourceColumnIndex = averageColumnIndex(sourceTable, relation.source.columns);
  const targetColumnIndex = averageColumnIndex(targetTable, relation.target.columns);

  const sourceY = sourcePosition.y + CARD_HEADER_HEIGHT + sourceColumnIndex * COLUMN_HEIGHT + COLUMN_HEIGHT / 2;
  const targetY = targetPosition.y + CARD_HEADER_HEIGHT + targetColumnIndex * COLUMN_HEIGHT + COLUMN_HEIGHT / 2;
  const sourceCenter = sourcePosition.x + sourcePosition.width / 2;
  const targetCenter = targetPosition.x + targetPosition.width / 2;

  let path;

  if (Math.abs(sourcePosition.x - targetPosition.x) < 10) {
    const startX = sourcePosition.x + sourcePosition.width;
    const endX = targetPosition.x + targetPosition.width;
    const controlX = sourcePosition.x + sourcePosition.width + 120;
    path = `M ${startX} ${sourceY} C ${controlX} ${sourceY}, ${controlX} ${targetY}, ${endX} ${targetY}`;
  } else {
    const startX = sourceCenter <= targetCenter ? sourcePosition.x + sourcePosition.width : sourcePosition.x;
    const endX = sourceCenter <= targetCenter ? targetPosition.x : targetPosition.x + targetPosition.width;
    const distance = Math.max(90, Math.abs(endX - startX) * 0.45);
    const controlAX = sourceCenter <= targetCenter ? startX + distance : startX - distance;
    const controlBX = sourceCenter <= targetCenter ? endX - distance : endX + distance;
    path = `M ${startX} ${sourceY} C ${controlAX} ${sourceY}, ${controlBX} ${targetY}, ${endX} ${targetY}`;
  }

  const isActive =
    state.selectedTableId &&
    (relation.sourceTableId === state.selectedTableId || relation.targetTableId === state.selectedTableId);
  const isMuted = state.selectedTableId && !isActive;

  return `
    <path
      class="erd-edge ${isActive ? "is-active" : ""} ${isMuted ? "is-muted" : ""}"
      d="${path}"
    >
      <title>${escapeHtml(`${relation.name}: ${relation.sourceTableId} -> ${relation.targetTableId}`)}</title>
    </path>
  `;
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

function selectTable(tableId, options) {
  state.selectedTableId = tableId;
  render();

  if (options && options.center) {
    centerTable(tableId);
  }
}

function centerTable(tableId) {
  const tablePosition = state.layout.tables.get(tableId);
  if (!tablePosition) {
    return;
  }

  const viewportRect = elements.viewport.getBoundingClientRect();
  const scale = Math.max(state.view.scale, 0.9);
  const targetX = viewportRect.width / 2 - (tablePosition.x + tablePosition.width / 2) * scale;
  const targetY = viewportRect.height / 2 - (tablePosition.y + tablePosition.height / 2) * scale;

  state.view.scale = scale;
  state.view.x = targetX;
  state.view.y = targetY;
  applyViewport();
}

function fitToViewport() {
  if (!state.currentTables.length) {
    return;
  }

  const viewportRect = elements.viewport.getBoundingClientRect();
  const margin = 80;
  const contentWidth = Math.max(state.layout.width - 32, 1);
  const contentHeight = Math.max(state.layout.height - 32, 1);
  const scale = clamp(
    Math.min((viewportRect.width - margin) / contentWidth, (viewportRect.height - margin) / contentHeight),
    0.35,
    1,
  );

  state.view.scale = scale;
  state.view.x = (viewportRect.width - contentWidth * scale) / 2;
  state.view.y = (viewportRect.height - contentHeight * scale) / 2;
  applyViewport();
}

function resetViewport() {
  state.view.x = 64;
  state.view.y = 64;
  state.view.scale = 1;
  applyViewport();
}

function applyViewport() {
  elements.stage.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
}

function isSchemaVisible(schemaName) {
  return state.activeSchemas.size === 0 || state.activeSchemas.has(schemaName);
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
