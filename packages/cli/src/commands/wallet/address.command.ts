import { Inject } from '@nestjs/common';
import { SubCommand } from 'nest-commander';
import { log, logerror } from 'src/common';
import { ConfigService, WalletService } from 'src/providers';
import { BaseCommand, BaseCommandOptions } from '../base.command';

interface AddressCommandOptions extends BaseCommandOptions {}

@SubCommand({
  name: 'address',
  description: 'Show address',
})
export class AddressCommand extends BaseCommand {
  constructor(
    @Inject() protected readonly walletService: WalletService,
    @Inject() protected readonly configService: ConfigService,
  ) {
    super(walletService, configService);
  }

  async cat_cli_run(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    inputs: string[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options?: AddressCommandOptions,
  ): Promise<void> {
    try {
      const address = this.walletService.getAddress();

      log(`Your address is ${address}`);
    } catch (error) {
      logerror('Get address failed!', error);
    }
  }
}
