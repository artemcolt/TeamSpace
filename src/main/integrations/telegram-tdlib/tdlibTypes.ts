export type TdlibObject = {
  '@type': string;
  '@extra'?: string;
  [key: string]: unknown;
};

export type TdlibRequest = TdlibObject;
export type TdlibResponse = TdlibObject;
export type TdlibUpdate = TdlibObject;
