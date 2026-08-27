export function createDecoder({ name, version, match, decode }) {
  if (!name || !version || typeof match !== 'function' || typeof decode !== 'function') {
    throw new TypeError('invalid_decoder_definition');
  }
  return Object.freeze({ name, version, match, decode });
}

export function decodeExact(decoder, transaction) {
  if (!decoder.match(transaction)) return [];
  const events = decoder.decode(transaction);
  if (!Array.isArray(events)) throw new TypeError('decoder_must_return_array');
  return events;
}
