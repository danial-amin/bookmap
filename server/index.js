import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "..", "dist");
const port = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.static(dist));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "bookmap" });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(dist, "index.html"));
});

app.listen(port, () => {
  console.log(`Bookmap listening on http://localhost:${port}`);
});
