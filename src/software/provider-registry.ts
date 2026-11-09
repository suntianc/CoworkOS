import { SoftwareProtocolError, type ResourceTarget, type SoftwareProvider } from "./contracts.js";
/** Registration is installation-time trusted code, never a model-provided executable. */
export class SoftwareProviderRegistry {
  private readonly providers = new Map<string, SoftwareProvider>();
  register(provider: SoftwareProvider): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- provider 是安装期加载的外部驱动，可能是按旧协议构建的模块；协议号 2 只是本仓类型约定，运行时必须拒绝旧协议
    if (provider.protocolVersion !== 2 || this.providers.has(provider.id))
      throw new Error("Unsupported protocol or duplicate software provider");
    this.providers.set(provider.id, provider);
  }
  resolve(id: string, target: ResourceTarget): SoftwareProvider {
    const provider = this.providers.get(id);
    if (!provider || !provider.resourceKinds.includes(target.kind))
      throw new SoftwareProtocolError("unsupported_resource", `Provider ${id} cannot open ${target.kind}`);
    return provider;
  }
  async close(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => provider.close?.()));
  }
}
