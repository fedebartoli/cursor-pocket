// Codificatore protobuf minimo per i test: costruisce un `toolCallBinary` come quello osservato in Cursor.
const varint = (n) => {
  const out = [];
  let v = n;
  while (v > 127) {
    out.push((v & 127) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
};
const bytes = (f, b) => Buffer.concat([varint(f * 8 + 2), varint(b.length), b]);
const str = (f, s) => bytes(f, Buffer.from(s, 'utf8'));

export function encodeQuestion({ title, questions }) {
  const qs = questions.map((q) =>
    bytes(2, Buffer.concat([str(1, q.id), str(2, q.prompt), ...q.options.map((o) => bytes(3, Buffer.concat([str(1, o.id), str(2, o.label)])))])),
  );
  return Buffer.concat([bytes(23, bytes(1, Buffer.concat([...(title ? [str(1, title)] : []), ...qs]))), str(57, 'tool_abc')]).toString('base64');
}
