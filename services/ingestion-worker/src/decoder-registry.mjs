import { jupiterDecoder } from './decoders/jupiter.mjs';
import { raydiumDecoder } from './decoders/raydium.mjs';
import { orcaDecoder } from './decoders/orca.mjs';

export const decoderRegistry = Object.freeze([jupiterDecoder, raydiumDecoder, orcaDecoder]);
