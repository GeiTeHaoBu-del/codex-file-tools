import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import fs from "node:fs"
import path from "node:path"
import { createTwoFilesPatch } from "diff"

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const DEFAULT_IGNORE = new Set([
  "node_modules", ".git", ".hg", ".svn", "__pycache__",
  ".DS_Store", "Thumbs.db", "dist", "build", ".next",
  ".cache", "target", ".tox", ".eggs", "*.egg-info",
])

const MAX_SEARCH_RESULTS = 100
const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024

function globToRegex(glob) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*" && (glob[i + 2] === "/" || glob[i + 2] === "\\" || i + 2 >= glob.length)) {
        re += ".*"
        i += glob[i + 1] === "*" ? 1 : 0
      } else {
        re += "[^/\\\\]*"
      }
    } else if (c === "?") {
      re += "[^/\\\\]"
    } else if (c === ".") {
      re += "\\."
    } else {
      re += c
    }
  }
  return new RegExp("^" + re + "$", "i")
}

function detectBom(raw) {
  return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
}

function readFileMeta(filePath) {
  const raw = fs.readFileSync(filePath)
  const hasBom = detectBom(raw)
  const text = (hasBom ? raw.subarray(3) : raw).toString("utf-8")
  const usesCRLF = text.includes("\r\n")
  const lf = usesCRLF ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : text
  return { raw, text, hasBom, usesCRLF, lf }
}

function toFileStyle(str, usesCRLF) {
  return usesCRLF ? str.replace(/\n/g, "\r\n") : str
}

function fromFileStyle(str) {
  return str.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

const server = new Server(
  { name: "codex-file-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_file",
      description:
        "Read a file's contents. Supports line offset and limit for large files. " +
        "Returns lines prefixed with line numbers like '1: content'.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
          offset: { type: "number", description: "Line number to start from (1-indexed)" },
          limit: { type: "number", description: "Max lines to read (default 2000)" },
        },
        required: ["filePath"],
      },
    },
    {
      name: "write_file",
      description:
        "Create a new file or overwrite an existing one. Auto-creates parent directories. " +
        "Returns a diff showing what changed.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "The content to write" },
        },
        required: ["filePath", "content"],
      },
    },
    {
      name: "edit_file",
      description:
        "Edit a file by exact string replacement. The oldString MUST exactly match a " +
        "unique substring in the file (including whitespace, indentation, blank lines, " +
        "and surrounding code exactly as it appears). " +
        "LINE ENDINGS: Use \\n (LF) for line breaks regardless of the file's actual line " +
        "ending style (CRLF vs LF is auto-normalized before matching). " +
        "BOM: UTF-8 BOM is auto-stripped before matching and auto-preserved on write. " +
        "If oldString is not found or matches multiple times, the edit fails with an error. " +
        "Returns a unified diff of the change.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
          oldString: {
            type: "string",
            description: "Exact text to find and replace",
          },
          newString: {
            type: "string",
            description: "The replacement text",
          },
        },
        required: ["filePath", "oldString", "newString"],
      },
    },
    {
      name: "search_file",
      description:
        "Fast multi-file search with regex support. Searches file contents across a directory tree. " +
        "Returns matching file paths, line numbers, and the matching line content. " +
        "Use mode: 'regex' (default) or 'literal' for plain text search. " +
        "Supports fileGlob to filter by extension (e.g. '*.ts', '*.{js,ts}'). " +
        "Automatically skips binary files and common ignored directories (node_modules, .git, etc.). " +
        "Capped at " + MAX_SEARCH_RESULTS + " results; narrow your pattern or directory if truncated.",
      inputSchema: {
        type: "object",
        properties: {
          rootPath: { type: "string", description: "Directory to search in (absolute path)" },
          pattern: { type: "string", description: "Search pattern (regex or literal text)" },
          fileGlob: { type: "string", description: "File glob filter, e.g. '*.ts' or '*.{js,ts}'" },
          mode: { type: "string", enum: ["regex", "literal"], description: "Search mode. Default: regex" },
          maxResults: { type: "number", description: "Max results. Default: 100" },
        },
        required: ["rootPath", "pattern"],
      },
    },
    {
      name: "list_dir",
      description:
        "List contents of a directory. Returns structured output with name, path, size, and isDir for each entry. " +
        "Supports recursive listing up to a depth limit. Use fileGlob to filter entries.",
      inputSchema: {
        type: "object",
        properties: {
          dirPath: { type: "string", description: "Directory to list (absolute path)" },
          recursive: { type: "boolean", description: "Recursively list subdirectories" },
          maxDepth: { type: "number", description: "Max recursion depth (default: 3, max: 10)" },
          fileGlob: { type: "string", description: "Filter by glob, e.g. '*.ts'" },
        },
        required: ["dirPath"],
      },
    },
    {
      name: "move_file",
      description:
        "Move or rename a file/directory. Source and target must be absolute paths. " +
        "Auto-creates parent directories of the target path.",
      inputSchema: {
        type: "object",
        properties: {
          oldPath: { type: "string", description: "Current path (absolute)" },
          newPath: { type: "string", description: "New path (absolute)" },
        },
        required: ["oldPath", "newPath"],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const arg = args ?? {}

  try {
    switch (name) {
      case "read_file": {
        const filePath = String(arg.filePath || "")
        if (!fs.existsSync(filePath)) {
          const dir = path.dirname(filePath)
          const base = path.basename(filePath).toLowerCase()
          let hint = ""
          try {
            const items = fs.readdirSync(dir).filter((n) => n.toLowerCase().includes(base))
            if (items.length) hint = `\nDid you mean: ${items.slice(0, 3).join(", ")}?`
          } catch {}
          return { content: [{ type: "text", text: `File not found: ${filePath}${hint}` }], isError: true }
        }

        const stat = fs.statSync(filePath)
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(filePath)
          return {
            content: [
              {
                type: "text",
                text: `<directory path="${filePath}">\n${entries.sort().join("\n")}\n(${entries.length} entries)</directory>`,
              },
            ],
          }
        }

        const offset = Number(arg.offset || 1)
        const limit = Number(arg.limit || 2000)
        const raw = fs.readFileSync(filePath)
        const hasBom = detectBom(raw)
        const text = (hasBom ? raw.subarray(3) : raw).toString("utf-8")
        const content = fromFileStyle(text)
        const lines = content.split("\n")
        const start = offset - 1
        const slice = lines.slice(start, start + limit)
        const output = slice.map((line, i) => `${offset + i}: ${line}`).join("\n")
        const footer =
          start + slice.length < lines.length
            ? `\n\n(Showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}. Use offset=${offset + slice.length} to continue.)`
            : `\n\n(End of file - total ${lines.length} lines)`

        return { content: [{ type: "text", text: output + footer }] }
      }

      case "write_file": {
        const filePath = String(arg.filePath || "")
        const content = String(arg.content || "")
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        let oldRaw = Buffer.alloc(0)
        let preserveBom = false
        if (fs.existsSync(filePath)) {
          oldRaw = fs.readFileSync(filePath)
          preserveBom = detectBom(oldRaw)
        }
        const old = fromFileStyle((preserveBom ? oldRaw.subarray(3) : oldRaw).toString("utf-8"))
        fs.writeFileSync(filePath, preserveBom ? Buffer.concat([BOM, Buffer.from(content, "utf-8")]) : content)
        const diff = createTwoFilesPatch(filePath, filePath, old, content, "", "")
        return { content: [{ type: "text", text: `Wrote ${filePath}.\n\n${diff}` }] }
      }

      case "edit_file": {
        const filePath = String(arg.filePath || "")
        const oldStr = String(arg.oldString || "")
        const newStr = String(arg.newString || "")

        if (!fs.existsSync(filePath)) {
          return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true }
        }

        const meta = readFileMeta(filePath)
        const matchOld = fromFileStyle(oldStr)
        const fileLf = meta.lf

        const idx = fileLf.indexOf(matchOld)
        if (idx === -1) {
          const snippet = fileLf.length > 200
            ? fileLf.substring(0, 100) + "..." + fileLf.substring(fileLf.length - 100)
            : fileLf
          const oldSnippet = oldStr.length > 80 ? oldStr.substring(0, 80) + "..." : oldStr
          return {
            content: [{
              type: "text",
              text:
                `oldString not found in ${filePath}. The file has ${meta.usesCRLF ? "CRLF" : "LF"} line endings${meta.hasBom ? " and a UTF-8 BOM" : ""}.\n\n` +
                `Search text (first 80 chars): "${oldSnippet}"\n` +
                `File start (first 100 chars): "${snippet.substring(0, 100)}"\n\n` +
                `Tip: Line endings in oldString are auto-normalized, but check for hidden differences in whitespace/indentation.`
            }],
            isError: true,
          }
        }
        const count = fileLf.split(matchOld).length - 1
        if (count > 1) {
          return {
            content: [{
              type: "text",
              text: `Found ${count} matches for oldString in ${filePath}. Provide more surrounding context (more lines before/after) to uniquely identify the target location.`
            }],
            isError: true,
          }
        }

        const matchNew = fromFileStyle(newStr)
        const newLf = fileLf.slice(0, idx) + matchNew + fileLf.slice(idx + matchOld.length)

        const outputContent = toFileStyle(newLf, meta.usesCRLF)
        const outputBytes = meta.hasBom
          ? Buffer.concat([BOM, Buffer.from(outputContent, "utf-8")])
          : outputContent
        fs.writeFileSync(filePath, outputBytes)

        const diffOld = fileLf
        const diffNew = newLf
        const diffOutput = createTwoFilesPatch(filePath, filePath, diffOld, diffNew, "", "")
        return {
          content: [{
            type: "text",
            text: `Edit applied to ${filePath}. (BOM: ${meta.hasBom}, line endings: ${meta.usesCRLF ? "CRLF" : "LF"})\n\n${diffOutput}`
          }]
        }
      }

      case "search_file": {
        const rootPath = String(arg.rootPath || "")
        const pattern = String(arg.pattern || "")
        const fileGlob = arg.fileGlob ? String(arg.fileGlob) : null
        const mode = arg.mode === "literal" ? "literal" : "regex"
        const maxResults = Number(arg.maxResults) || MAX_SEARCH_RESULTS

        if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
          return { content: [{ type: "text", text: `Directory not found: ${rootPath}` }], isError: true }
        }

        let searchRe
        try {
          searchRe = new RegExp(pattern, mode === "literal" ? "" : "gi")
        } catch {
          try {
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            searchRe = new RegExp(escaped, mode === "literal" ? "" : "gi")
          } catch {
            return { content: [{ type: "text", text: `Invalid pattern: ${pattern}` }], isError: true }
          }
        }

        const fileRe = fileGlob ? globToRegex(fileGlob) : null
        const results = []
        const queue = [{ filePath: rootPath, relPath: "" }]
        let truncated = false

        for (let qi = 0; qi < queue.length && results.length < maxResults; qi++) {
          const { filePath: dir, relPath: relDir } = queue[qi]
          let entries
          try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
          catch { continue }

          for (const entry of entries) {
            if (results.length >= maxResults) { truncated = true; break }
            const fullPath = path.join(dir, entry.name)
            const relPath = relDir ? relDir + "/" + entry.name : entry.name

            if (entry.isDirectory()) {
              if (DEFAULT_IGNORE.has(entry.name)) continue
              queue.push({ filePath: fullPath, relPath })
              continue
            }

            if (!entry.isFile()) continue
            if (fileRe && !fileRe.test(entry.name)) continue

            let stat
            try { stat = fs.statSync(fullPath) }
            catch { continue }
            if (stat.size > MAX_SEARCH_FILE_SIZE) continue

            let text
            try { text = fs.readFileSync(fullPath, "utf-8") }
            catch { continue }

            if (text.includes("\0") && text.length < 8000) continue

            const lines = text.split("\n")
            for (let li = 0; li < lines.length && results.length < maxResults; li++) {
              const match = lines[li].match(searchRe)
              if (!match) continue
              let display = lines[li].trimEnd()
              if (display.length > 200) display = display.substring(0, 200) + "..."
              results.push({
                file: relPath,
                line: li + 1,
                content: display,
              })
            }
          }
        }

        const grouped = {}
        for (const r of results) {
          if (!grouped[r.file]) grouped[r.file] = []
          grouped[r.file].push(r)
        }

        let output = `Found ${results.length} results in ${rootPath}`
        if (truncated) output += ` (truncated, increase maxResults to see more)`
        output += ":\n"

        for (const [file, matches] of Object.entries(grouped)) {
          output += `\n${file}:\n`
          for (const m of matches) {
            output += `  ${m.line}: ${m.content}\n`
          }
        }

        if (results.length === 0) output = `No results found for "${pattern}" in ${rootPath}`
        return { content: [{ type: "text", text: output }] }
      }

      case "list_dir": {
        const dirPath = String(arg.dirPath || "")
        const recursive = arg.recursive === true
        const maxDepth = Math.min(Number(arg.maxDepth) || 3, 10)
        const fileGlob = arg.fileGlob ? String(arg.fileGlob) : null

        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return { content: [{ type: "text", text: `Directory not found: ${dirPath}` }], isError: true }
        }

        const fileRe = fileGlob ? globToRegex(fileGlob) : null
        const allEntries = []
        const queue = [{ dir: dirPath, depth: 0, prefix: "" }]

        for (let qi = 0; qi < queue.length; qi++) {
          const { dir, depth, prefix } = queue[qi]
          let entries
          try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
          catch { continue }

          const dirs = []
          const files = []
          for (const e of entries) {
            if (e.name.startsWith(".") && DEFAULT_IGNORE.has(e.name)) continue
            if (e.isDirectory()) dirs.push(e)
            else if (e.isFile()) files.push(e)
            else continue
          }

          for (const e of dirs) {
            const entry = {
              name: prefix + e.name + "/",
              path: path.join(dir, e.name),
              size: 0,
              isDir: true,
            }
            allEntries.push(entry)
            if (recursive && depth < maxDepth) {
              queue.push({ dir: path.join(dir, e.name), depth: depth + 1, prefix: prefix + e.name + "/" })
            }
          }

          for (const e of files) {
            if (fileRe && !fileRe.test(e.name)) continue
            let stat
            try { stat = fs.statSync(path.join(dir, e.name)) }
            catch { stat = { size: 0 } }
            allEntries.push({
              name: prefix + e.name,
              path: path.join(dir, e.name),
              size: stat.size,
              isDir: false,
            })
          }
        }

        allEntries.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })

        const lines = allEntries.map((e) =>
          `${e.isDir ? "[D]" : "[F]"} ${rightPad(formatSize(e.size), 10)} ${e.name}`
        )

        return {
          content: [{ type: "text", text: `<directory path="${dirPath}">\n${lines.join("\n")}\n\n(${allEntries.length} entries)</directory>` }]
        }
      }

      case "move_file": {
        const oldPath = String(arg.oldPath || "")
        const newPath = String(arg.newPath || "")

        if (!fs.existsSync(oldPath)) {
          return { content: [{ type: "text", text: `Source not found: ${oldPath}` }], isError: true }
        }
        if (fs.existsSync(newPath)) {
          return { content: [{ type: "text", text: `Target already exists: ${newPath}` }], isError: true }
        }

        fs.mkdirSync(path.dirname(newPath), { recursive: true })
        fs.renameSync(oldPath, newPath)
        return { content: [{ type: "text", text: `Moved ${oldPath} -> ${newPath}` }] }
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
    }
  } catch (error) {
    return { content: [{ type: "text", text: String(error) }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

function rightPad(str, len) {
  return str.length >= len ? str : str + " ".repeat(len - str.length)
}

function formatSize(bytes) {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i]
}
