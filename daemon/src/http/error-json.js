/** JSON body for API errors (`error`, English `message`, optional `detail` and `params`). */
export function errorJson(err) {
  const body = { error: err.code, message: err.message };
  if (err.detail) body.detail = err.detail;
  if (err.params && Object.keys(err.params).length) body.params = err.params;
  return body;
}
