// Delivers serial output to a host's callbacks: raw bytes, decoded text, and
// complete lines (without "\r\n").

export function serialOutput(target) {
  const decoder = new TextDecoder();
  let lineBuf = '';

  return (bytes) => {
    target.onBytes?.(bytes);
    if (!target.onData && !target.onLine) return;

    const text = decoder.decode(bytes, { stream: true });
    target.onData?.(text);
    if (target.onLine) {
      lineBuf += text;
      let i;
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        target.onLine(lineBuf.slice(0, i).replace(/\r$/, ''));
        lineBuf = lineBuf.slice(i + 1);
      }
    }
  };
}

const encoder = new TextEncoder();

export function toBytes(data) {
  return typeof data === 'string' ? encoder.encode(data) : data;
}
