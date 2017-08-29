const regex = /(?:^[#?]?|&)([^=&]+)(?:=([^&]*))?/g;

/**
 * Parses the query string of an URL. This method returns a simple key/value
 * map. If there are duplicate keys the latest value is returned.
 *
 * @param {string} queryString
 * @return {!JsonObject}
 */
export function parseQueryString(queryString) {
  const params = /** @type {!JsonObject} */ (Object.create(null));
  if (!queryString) {
    return params;
  }

  let match;
  while ((match = regex.exec(queryString))) {
    const name = decodeURIComponent(match[1]).trim();
    const value = match[2] ?
      decodeURIComponent(match[2]).trim() :
        '';
    params[name] = value;
  }
  return params;
}