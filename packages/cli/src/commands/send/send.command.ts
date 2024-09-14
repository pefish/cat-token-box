import { Inject } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Command, InquirerService, Option } from 'nest-commander';
import { int2ByteString } from 'scrypt-ts';
import {
  broadcast,
  btc,
  getTokens,
  getUtxos,
  logerror,
  needRetry,
  OpenMinterTokenInfo,
  sleep,
  TokenMetadata,
  unScaleByDecimals,
} from 'src/common';
import { ConfigService, SpendService, WalletService } from 'src/providers';
import { RetrySendQuestionAnswers } from 'src/questions/retry-send.question';
import { findTokenMetadataById, scaleConfig } from 'src/token';
import {
  BoardcastCommand,
  BoardcastCommandOptions,
} from '../boardcast.command';
import { sendToken } from './ft';
import { isMergeTxFail, mergeTokens, waitTxConfirm } from './merge';
import { pick, pickLargeFeeUtxo } from './pick';

interface SendCommandOptions extends BoardcastCommandOptions {
  id: string;
  address: string;
  amount: bigint;
  config?: string;
}

@Command({
  name: 'send',
  description: 'Send tokens',
})
export class SendCommand extends BoardcastCommand {
  constructor(
    @Inject() private readonly inquirer: InquirerService,
    @Inject() private readonly spendService: SpendService,
    @Inject() protected readonly walletService: WalletService,
    @Inject() protected readonly configService: ConfigService,
  ) {
    super(spendService, walletService, configService);
  }
  async cat_cli_run(
    inputs: string[],
    options?: SendCommandOptions,
  ): Promise<void> {
    try {
      const address = this.walletService.getAddress();
      let receiver: btc.Address;
      let amount: bigint;
      try {
        receiver = btc.Address.fromString(inputs[0]);

        if (receiver.type !== 'taproot') {
          console.error(`Invalid address type: ${receiver.type}`);
          return;
        }
      } catch (error) {
        console.error(`Invalid receiver address: "${inputs[0]}" `);
        return;
      }

      const feeRate = await this.getFeeRate();
      console.log(`feeRate: ${feeRate}`);

      if (!options.id) {
        const feeUtxos = await getUtxos(
          this.configService,
          this.walletService,
          address,
        );
        if (feeUtxos.length === 0) {
          console.warn('Insufficient satoshis balance!');
          return;
        }

        let tx;
        if (!inputs[1] || inputs[1] == '0' || inputs[1] == '') {
          tx = new btc.Transaction()
            .from(feeUtxos)
            .feePerByte(feeRate)
            .change(receiver);
        } else {
          const d = new Decimal(inputs[1]).mul(Math.pow(10, 8));
          amount = BigInt(d.toString());
          console.log(int2ByteString(amount, 8n));
          tx = new btc.Transaction()
            .from(feeUtxos)
            .addOutput(
              new btc.Transaction.Output({
                satoshis: int2ByteString(amount, 8n),
                script: btc.Script.fromAddress(receiver),
              }),
            )
            .feePerByte(feeRate)
            .change(address);
        }

        this.walletService.signTx(tx);
        const txId = await broadcast(
          this.configService,
          this.walletService,
          tx.uncheckedSerialize(),
        );

        if (txId instanceof Error) {
          throw txId;
        }
        waitTxConfirm(this.configService, txId, 1);
        return;
      }
      const token = await findTokenMetadataById(this.configService, options.id);

      if (!token) {
        throw new Error(`No token metadata found for tokenId: ${options.id}`);
      }

      const scaledInfo = scaleConfig(token.info as OpenMinterTokenInfo);

      try {
        const d = new Decimal(inputs[1]).mul(Math.pow(10, scaledInfo.decimals));
        amount = BigInt(d.toString());
      } catch (error) {
        logerror(`Invalid amount: "${inputs[1]}"`, error);
        return;
      }

      do {
        try {
          await this.send(token, receiver, amount, address, feeRate);
          return;
        } catch (error) {
          // if merge failed, we can auto retry
          if (isMergeTxFail(error)) {
            logerror(`Merge [${token.info.symbol}] tokens failed.`, error);
            console.warn(`retry to merge [${token.info.symbol}] tokens ...`);
            await sleep(6);
            continue;
          }

          if (needRetry(error)) {
            // if send token failed, we request to retry
            const { retry } = await this.inquirer.ask<RetrySendQuestionAnswers>(
              'retry_send_question',
              {},
            );

            if (retry === 'abort') {
              return;
            }
            console.warn(`retry to send token [${token.info.symbol}] ...`);
          } else {
            throw error;
          }
        }
      } while (true);
    } catch (error) {
      logerror(`send token failed!`, error);
    }
  }

  async send(
    token: TokenMetadata,
    receiver: btc.Address,
    amount: bigint,
    address: btc.Address,
    feeRate: number,
  ) {
    let feeUtxos = await getUtxos(
      this.configService,
      this.walletService,
      address,
    );

    feeUtxos = feeUtxos.filter((utxo) => {
      return this.spendService.isUnspent(utxo);
    });

    if (feeUtxos.length === 0) {
      console.warn('Insufficient satoshis balance!');
      return;
    }

    const res = await getTokens(
      this.configService,
      this.spendService,
      token,
      address,
    );

    if (res === null) {
      return;
    }

    const { contracts } = res;

    let tokenContracts = pick(contracts, amount);

    if (tokenContracts.length === 0) {
      console.warn('Insufficient token balance!');
      return;
    }

    const cachedTxs: Map<string, btc.Transaction> = new Map();
    if (tokenContracts.length > 4) {
      console.info(`Merging your [${token.info.symbol}] tokens ...`);
      const [mergedTokens, newfeeUtxos, e] = await mergeTokens(
        this.configService,
        this.walletService,
        this.spendService,
        feeUtxos,
        feeRate,
        token,
        tokenContracts,
        address,
        cachedTxs,
      );

      if (e instanceof Error) {
        logerror('merge token failed!', e);
        return;
      }

      tokenContracts = mergedTokens;
      feeUtxos = newfeeUtxos;
    }

    const feeUtxo = pickLargeFeeUtxo(feeUtxos);

    const result = await sendToken(
      this.configService,
      this.walletService,
      feeUtxo,
      feeRate,
      token,
      tokenContracts,
      address,
      receiver,
      amount,
      cachedTxs,
    );

    if (result) {
      const commitTxId = await broadcast(
        this.configService,
        this.walletService,
        result.commitTx.uncheckedSerialize(),
      );

      if (commitTxId instanceof Error) {
        throw commitTxId;
      }

      this.spendService.updateSpends(result.commitTx);

      const revealTxId = await broadcast(
        this.configService,
        this.walletService,
        result.revealTx.uncheckedSerialize(),
      );

      if (revealTxId instanceof Error) {
        throw revealTxId;
      }

      this.spendService.updateSpends(result.revealTx);

      console.log(
        `Sending ${unScaleByDecimals(amount, token.info.decimals)} ${token.info.symbol} tokens to ${receiver} \nin txid: ${result.revealTx.id}`,
      );
    }
  }

  @Option({
    flags: '-i, --id [tokenId]',
    description: 'ID of the token',
  })
  parseId(val: string): string {
    return val;
  }
}
