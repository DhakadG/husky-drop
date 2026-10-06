// Turning a drop into a file list, DOM-free so scripts/drop-walk-test.mjs can
// run it under node with a fake DataTransfer.
//
// Dropped folders are walked through the FileSystem entry API, so each file
// keeps its relative path ("Trip/Day 1/IMG.jpg") and the Drive folder tree
// can be mirrored server-side. If the walk fails for any reason, the drop
// falls back to the flat file list rather than silently losing files.

const CAP = 20000;

// Must be called synchronously inside the drop handler: the DataTransfer is
// emptied once the handler yields, so both lists are read up front.
export function filesFromDrop(dt) {
  const flat = [...(dt.files || [])];
  const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Promise.resolve(flat);
  return walkEntries(entries).catch(() => flat);
}

async function walkEntries(entries) {
  const out = [];
  const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  // readEntries hands a directory over in batches and must be drained in
  // order; sibling subtrees are independent, so they are walked in parallel
  // and the result is put back in natural path order (IMG_2 before IMG_10).
  const readAll = async (reader) => {
    const batch = await readBatch(reader);
    return batch.length ? [...batch, ...(await readAll(reader))] : [];
  };
  async function walk(entry, path) {
    if (out.length >= CAP) return;
    if (entry.isFile) {
      const file = await entryFile(entry);
      out.push({ file, rel: path ? `${path}${file.name}` : "" });
      return;
    }
    if (!entry.isDirectory) return;
    const children = await readAll(entry.createReader());
    await Promise.all(children.map((child) => walk(child, `${path}${entry.name}/`)));
  }
  await Promise.all(entries.map((entry) => walk(entry, "")));
  const key = (x) => x.rel || x.file.name;
  return out.sort((x, y) => key(x).localeCompare(key(y), undefined, { numeric: true, sensitivity: "base" }));
}
