import { type DynamicModule, Module } from '@nestjs/common';
import type { TenantTx } from '../../db/tenant-transaction';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { SchedulingModule } from '../scheduling/scheduling.module';
import type { MensageiroWhatsApp } from './mensageiro-whatsapp';
import { FONTE_DE_RESPONSAVEIS, ResponsaveisPeloCatalogo, type FonteDeResponsaveis } from './responsaveis.port';
import { WhatsappController, WhatsappWebhookController } from './whatsapp.controller';
import { MENSAGEIRO_WHATSAPP, WhatsappService } from './whatsapp.service';

/**
 * Lembretes e confirmação por WhatsApp (rodada 18.3). Peças plugáveis: o adaptador do canal (null =
 * desligado, o padrão) e a fonte de responsáveis (padrão: pelo catálogo, tolerando a ausência das
 * tabelas da 0028 nesta branch).
 */
@Module({})
export class MessagingModule {
  static forRoot(opcoes: { mensageiro: MensageiroWhatsApp | null; responsaveis?: FonteDeResponsaveis }): DynamicModule {
    return {
      module: MessagingModule,
      imports: [SchedulingModule],
      controllers: [WhatsappController, WhatsappWebhookController],
      providers: [
        WhatsappService,
        { provide: MENSAGEIRO_WHATSAPP, useValue: opcoes.mensageiro },
        opcoes.responsaveis
          ? { provide: FONTE_DE_RESPONSAVEIS, useValue: opcoes.responsaveis }
          : { provide: FONTE_DE_RESPONSAVEIS, useFactory: (cipher: FieldCipher<TenantTx>) => new ResponsaveisPeloCatalogo(cipher), inject: [FIELD_CIPHER] },
      ],
      exports: [WhatsappService],
    };
  }
}
