const crypto = require("crypto");
const path = require("path");

const Database = require("better-sqlite3");
const cors = require("cors");
const express = require("express");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "expenses.sqlite");

const app = express();
const db = new Database(DB_PATH);

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "16kb" }));
app.use(express.static(__dirname, { index: false }));

function run(sql, params = []) {
  const result = db.prepare(sql).run(...params);
  return {
    lastID: Number(result.lastInsertRowid),
    changes: result.changes,
  };
}

function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function initializeDatabase() {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      expense_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)");
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeExpenseInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "Request body must be a JSON object.");
  }

  const errors = [];
  const amount = Number(body.amount);
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const rawDate = typeof body.date === "string" ? body.date.trim() : "";

  if (body.amount === undefined || body.amount === null || body.amount === "") {
    errors.push("amount is required.");
  } else if (!Number.isFinite(amount)) {
    errors.push("amount must be a valid number.");
  } else if (amount <= 0) {
    errors.push("amount must be greater than 0.");
  }

  if (!category) {
    errors.push("category is required.");
  }

  if (!rawDate) {
    errors.push("date is required.");
  } else if (!isValidDateOnly(rawDate)) {
    errors.push("date must be a valid date in YYYY-MM-DD format.");
  }

  if (errors.length > 0) {
    const error = createHttpError(400, "Validation failed.");
    error.details = errors;
    throw error;
  }

  return {
    amount,
    category,
    description,
    date: rawDate,
  };
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function hashPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function getIdempotencyKey(req, normalizedExpense) {
  const headerKey = req.get("Idempotency-Key");

  if (headerKey && headerKey.trim()) {
    return `header:${headerKey.trim()}`;
  }

  return `body:${hashPayload(normalizedExpense)}`;
}

function findExpenseById(id) {
  return get(
    `
      SELECT id, amount, category, description, date, created_at
      FROM expenses
      WHERE id = ?
    `,
    [id]
  );
}

const createExpenseWithIdempotency = db.transaction(
  (expense, idempotencyKey, requestHash) => {
    const existingRequest = get(
      `
        SELECT expense_id, request_hash
        FROM expense_idempotency
        WHERE idempotency_key = ?
      `,
      [idempotencyKey]
    );

    if (existingRequest) {
      if (existingRequest.request_hash !== requestHash) {
        throw createHttpError(
          409,
          "Idempotency-Key was already used with a different request body."
        );
      }

      const existingExpense = findExpenseById(existingRequest.expense_id);
      return { expense: existingExpense, replayed: true };
    }

    const insertResult = run(
      `
        INSERT INTO expenses (amount, category, description, date)
        VALUES (?, ?, ?, ?)
      `,
      [expense.amount, expense.category, expense.description, expense.date]
    );

    run(
      `
        INSERT INTO expense_idempotency (idempotency_key, request_hash, expense_id)
        VALUES (?, ?, ?)
      `,
      [idempotencyKey, requestHash, insertResult.lastID]
    );

    const createdExpense = findExpenseById(insertResult.lastID);
    return { expense: createdExpense, replayed: false };
  }
);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/expenses", async (req, res, next) => {
  try {
    const expense = normalizeExpenseInput(req.body);
    const requestHash = hashPayload(expense);
    const idempotencyKey = getIdempotencyKey(req, expense);
    const result = await createExpenseWithIdempotency(
      expense,
      idempotencyKey,
      requestHash
    );

    res.status(result.replayed ? 200 : 201).json({
      data: result.expense,
      replayed: result.replayed,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/expenses", async (req, res, next) => {
  try {
    const filters = [];
    const params = [];
    const category =
      typeof req.query.category === "string" ? req.query.category.trim() : "";

    if (category) {
      filters.push("category = ?");
      params.push(category);
    }

    if (req.query.sort && req.query.sort !== "date_desc") {
      throw createHttpError(400, "Unsupported sort value. Use sort=date_desc.");
    }

    let sql = `
      SELECT id, amount, category, description, date, created_at
      FROM expenses
    `;

    if (filters.length > 0) {
      sql += ` WHERE ${filters.join(" AND ")}`;
    }

    if (req.query.sort === "date_desc") {
      sql += " ORDER BY date DESC, id DESC";
    } else {
      sql += " ORDER BY id ASC";
    }

    const expenses = await all(sql, params);
    res.status(200).json({ data: expenses });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: {
      message: "Route not found.",
    },
  });
});

app.use((error, req, res, next) => {
  const status = Number(error.status || 500);
  const response = {
    error: {
      message: status === 500 ? "Internal server error." : error.message,
    },
  };

  if (error.details) {
    response.error.details = error.details;
  }

  if (status === 500) {
    console.error(error);
  }

  res.status(status).json(response);
});

try {
  initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Expense Tracker API listening on port ${PORT}`);
  });
} catch (error) {
  console.error("Failed to initialize database.", error);
  process.exit(1);
}

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
