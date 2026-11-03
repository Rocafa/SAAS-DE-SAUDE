/** Fixture FICTÍCIO (R3): decorator de rota que a análise não trata tem de fazer a análise falhar com o nome. */
import { Controller, Head } from '@nestjs/common';

@Controller('ficticio-head')
export class DecoratorNaoTratadoController {
  @Head('x')
  cabecalho(): void {
    return undefined;
  }
}
