import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';

/** Depende dos módulos globais: TenancyModule (banco), CryptoModule (cifra) e AuthModule (sessão). */
@Module({
  controllers: [PatientsController],
  providers: [PatientsService],
  exports: [PatientsService],
})
export class PatientsModule {}
