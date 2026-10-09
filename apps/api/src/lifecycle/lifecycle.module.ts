import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ShutdownState } from './shutdown-state';

/** Estado de encerramento (global) + filtro de exceções que nunca vaza detalhe interno. */
@Global()
@Module({
  providers: [ShutdownState, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
  exports: [ShutdownState],
})
export class LifecycleModule {}
