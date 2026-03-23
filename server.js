"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3210);
const PUBLIC_DIR = path.join(__dirname, "public");
const BODY_LIMIT_BYTES = 1024 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

const METADATA_SQL = `
WITH user_tables AS (
  SELECT
    c.oid,
    n.nspname AS table_schema,
    c.relname AS table_name,
    c.relkind,
    CASE c.relkind
      WHEN 'r' THEN 'table'
      WHEN 'p' THEN 'partitioned table'
      WHEN 'f' THEN 'foreign table'
      ELSE c.relkind::text
    END AS table_type,
    COALESCE(obj_description(c.oid, 'pg_class'), '') AS description
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
),
pk_columns AS (
  SELECT
    con.conrelid AS table_oid,
    cols.attnum
  FROM pg_constraint con
  JOIN unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord) ON true
  WHERE con.contype = 'p'
),
unique_columns AS (
  SELECT DISTINCT
    con.conrelid AS table_oid,
    cols.attnum
  FROM pg_constraint con
  JOIN unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord) ON true
  WHERE con.contype IN ('p', 'u')
),
table_columns AS (
  SELECT
    t.oid AS table_oid,
    json_agg(
      json_build_object(
        'name', a.attname,
        'position', a.attnum,
        'dataType', format_type(a.atttypid, a.atttypmod),
        'nullable', NOT a.attnotnull,
        'defaultValue', pg_get_expr(ad.adbin, ad.adrelid),
        'isPrimaryKey', pk.attnum IS NOT NULL,
        'isUnique', uq.attnum IS NOT NULL,
        'isIdentity', a.attidentity <> '',
        'hasDefault', ad.adbin IS NOT NULL
      )
      ORDER BY a.attnum
    ) AS columns
  FROM user_tables t
  JOIN pg_attribute a ON a.attrelid = t.oid
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  LEFT JOIN pk_columns pk ON pk.table_oid = t.oid AND pk.attnum = a.attnum
  LEFT JOIN unique_columns uq ON uq.table_oid = t.oid AND uq.attnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped
  GROUP BY t.oid
),
table_payload AS (
  SELECT
    COALESCE(
      json_agg(
        json_build_object(
          'id', t.table_schema || '.' || t.table_name,
          'schema', t.table_schema,
          'name', t.table_name,
          'type', t.table_type,
          'description', t.description,
          'columns', COALESCE(c.columns, '[]'::json)
        )
        ORDER BY t.table_schema, t.table_name
      ),
      '[]'::json
    ) AS tables
  FROM user_tables t
  LEFT JOIN table_columns c ON c.table_oid = t.oid
),
relationship_payload AS (
  SELECT
    COALESCE(
      json_agg(
        json_build_object(
          'id', con.oid,
          'name', con.conname,
          'source', json_build_object(
            'schema', src_ns.nspname,
            'table', src.relname,
            'columns', src_cols.columns
          ),
          'target', json_build_object(
            'schema', tgt_ns.nspname,
            'table', tgt.relname,
            'columns', tgt_cols.columns
          ),
          'onUpdate', CASE con.confupdtype
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT'
            ELSE con.confupdtype::text
          END,
          'onDelete', CASE con.confdeltype
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT'
            ELSE con.confdeltype::text
          END
        )
        ORDER BY src_ns.nspname, src.relname, con.conname
      ),
      '[]'::json
    ) AS relationships
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_class tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
  JOIN LATERAL (
    SELECT json_agg(a.attname ORDER BY cols.ord) AS columns
    FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = cols.attnum
  ) src_cols ON true
  JOIN LATERAL (
    SELECT json_agg(a.attname ORDER BY cols.ord) AS columns
    FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = cols.attnum
  ) tgt_cols ON true
  WHERE con.contype = 'f'
    AND src_ns.nspname NOT IN ('pg_catalog', 'information_schema')
    AND tgt_ns.nspname NOT IN ('pg_catalog', 'information_schema')
    AND src_ns.nspname NOT LIKE 'pg_toast%'
    AND tgt_ns.nspname NOT LIKE 'pg_toast%'
)
SELECT json_build_object(
  'database', current_database(),
  'generatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'tables', table_payload.tables,
  'relationships', relationship_payload.relationships
)::text
FROM table_payload, relationship_payload;
`;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function normalizeConnection(input) {
  const value = input && typeof input === "object" ? input : {};

  return {
    host: typeof value.host === "string" ? value.host.trim() : "",
    port: value.port === undefined || value.port === null || value.port === "" ? "" : String(value.port).trim(),
    database: typeof value.database === "string" ? value.database.trim() : "",
    user: typeof value.user === "string" ? value.user.trim() : "",
    password: typeof value.password === "string" ? value.password : "",
    sslmode: typeof value.sslmode === "string" ? value.sslmode.trim() : "prefer",
  };
}

function validateConnection(connection) {
  const errors = [];

  if (!connection.database) {
    errors.push("Database name là bắt buộc.");
  }

  if (connection.port && !/^[0-9]+$/.test(connection.port)) {
    errors.push("Port phải là số nguyên hợp lệ.");
  }

  if (connection.sslmode && !["disable", "prefer", "require"].includes(connection.sslmode)) {
    errors.push("SSL mode không hợp lệ.");
  }

  return errors;
}

async function readBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;

    if (totalBytes > BODY_LIMIT_BYTES) {
      throw new Error("Payload quá lớn.");
    }

    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Body JSON không hợp lệ.");
  }
}

async function serveStatic(res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  const relativePath = path.relative(PUBLIC_DIR, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[extension] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": file.length,
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=60",
    });
    res.end(file);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }

    throw error;
  }
}

function buildPsqlArgs(connection) {
  const args = ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At"];

  if (connection.host) {
    args.push("-h", connection.host);
  }

  if (connection.port) {
    args.push("-p", connection.port);
  }

  if (connection.user) {
    args.push("-U", connection.user);
  }

  if (connection.database) {
    args.push("-d", connection.database);
  }

  return args;
}

function mapPsqlError(stderr) {
  const lines = String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return "psql trả về lỗi chưa xác định.";
  }

  return lines[lines.length - 1];
}

function querySchema(connection) {
  return new Promise((resolve, reject) => {
    const args = buildPsqlArgs(connection);
    const env = {
      ...process.env,
      PAGER: "cat",
      PSQLRC: "/dev/null",
      PGCONNECT_TIMEOUT: "8",
    };

    if (connection.password) {
      env.PGPASSWORD = connection.password;
    } else {
      delete env.PGPASSWORD;
    }

    if (connection.sslmode) {
      env.PGSSLMODE = connection.sslmode;
    } else {
      delete env.PGSSLMODE;
    }

    const child = spawn("psql", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const rawStdout = Buffer.concat(stdout).toString("utf8").trim();
      const rawStderr = Buffer.concat(stderr).toString("utf8").trim();

      if (code !== 0) {
        reject(new Error(mapPsqlError(rawStderr)));
        return;
      }

      if (!rawStdout) {
        reject(new Error("Không nhận được dữ liệu schema từ PostgreSQL."));
        return;
      }

      try {
        const parsed = JSON.parse(rawStdout);
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Không parse được JSON từ psql: ${error.message}`));
      }
    });

    child.stdin.end(METADATA_SQL);
  });
}

async function handleSchemaRequest(req, res) {
  let payload;

  try {
    payload = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const connection = normalizeConnection(payload);
  const validationErrors = validateConnection(connection);

  if (validationErrors.length) {
    sendJson(res, 400, { error: validationErrors.join(" ") });
    return;
  }

  try {
    const schema = await querySchema(connection);
    sendJson(res, 200, schema);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/schema") {
      await handleSchemaRequest(req, res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }

    sendText(res, 405, "Method not allowed");
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Server error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PostgreSQL View đang chạy tại http://${HOST}:${PORT}`);
});
