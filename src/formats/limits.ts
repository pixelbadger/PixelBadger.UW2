// Sanity limits for everything read from game data. The real UW2 files sit far below each of these; they exist so a
// malformed or hostile file cannot make a parser allocate gigabytes or loop forever. Raise one only with a comment
// naming the real file that needed it.

export const LIMITS = {
  /** Largest decompressed ark block (levels are 0x7e08 bytes; conversations a few KB). */
  maxDecompressed: 4 << 20,
  /** Blocks in one .ark file (LEV.ARK: 320, CNV.ARK: 256+). */
  maxArkBlocks: 4096,
  /** Images in one .GR file (OBJECTS.GR: 512). */
  maxGrImages: 4096,
  /** Total decoded pixels across one .GR file. */
  maxGrPixels: 16 << 20,
  /** Textures in T64.TR. */
  maxTextures: 1024,
  /** Huffman nodes in STRINGS.PAK (256 symbols -> 511 nodes). */
  maxHuffmanNodes: 1024,
  /** String blocks in STRINGS.PAK. */
  maxStringBlocks: 8192,
  /** Characters in one decoded string (the original engine's guard). */
  maxStringLength: 2000,
  /** Decoded characters across all of STRINGS.PAK. */
  maxStringChars: 32 << 20,
  /** Triangles in one executable model. */
  maxModelTris: 20000,
  /** Model node opcodes interpreted per model (nodes branch; this caps the whole walk). */
  maxModelOps: 200000,
  /** Model node nesting. */
  maxModelDepth: 64,
  /** Imports declared by one conversation. */
  maxConvImports: 512,
  /** Entries in one ISO 9660 directory. */
  maxIsoEntries: 8192,
  /** Instructions one ConvVM.run() may execute before it is declared runaway. */
  vmBudget: 2_000_000,
  /** Runtime strings (typed text, names, appends) one conversation may create. */
  vmMaxRuntimeStrings: 8192,
  /** Arguments a conversation builtin may take (the real maximum is 9). */
  vmMaxArgs: 16,
  /** Objects followed along one level link chain. */
  maxChain: 1024,
} as const;
