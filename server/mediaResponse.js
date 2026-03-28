/**
 * Send binary buffers with HTTP Range support (faster video start / seeking in browsers).
 */

/**
 * @returns {{ start: number, end: number } | null} null = send full entity (200)
 */
function parseHttpRange(req, size) {
  const range = req.headers.range;
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(range).trim());
  if (!m) return { error: 416 };
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return { error: 416 };
  if (start === null) {
    const suffix = end;
    if (suffix == null || Number.isNaN(suffix) || suffix < 1) return { error: 416 };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (end === null) {
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < 0 || start >= size || start > end) {
    return { error: 416 };
  }
  if (end >= size) end = size - 1;
  return { start, end };
}

function sendBufferWithRange(req, res, buffer, mime, cacheControl) {
  const size = buffer.length;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Vary', 'Cookie');

  const parsed = parseHttpRange(req, size);
  if (parsed && parsed.error === 416) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.end();
  }
  if (!parsed) {
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', cacheControl);
    return res.send(buffer);
  }

  const { start, end } = parsed;

  const chunk = buffer.subarray(start, end + 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', chunk.length);
  res.setHeader('Cache-Control', cacheControl);
  return res.send(chunk);
}

module.exports = { sendBufferWithRange, parseHttpRange };
