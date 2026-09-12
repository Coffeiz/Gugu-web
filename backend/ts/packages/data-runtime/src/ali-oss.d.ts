declare module "ali-oss" {
  type ClientOptions = {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    endpoint: string;
    region: string;
    secure?: boolean;
    enableProxy?: boolean;
    timeout?: number;
    retryMax?: number;
  };

  class OSS {
    constructor(options: ClientOptions);
    get(key: string, file?: undefined, options?: { timeout?: number }): Promise<{
      content?: Buffer;
      res?: { status?: number };
    }>;
  }

  export default OSS;
}
