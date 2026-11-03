/** Fixture FICTÍCIO (R3): decorator nosso que monta a rota por dentro tem de fazer a análise falhar com o nome. */
import { applyDecorators, Controller, HttpCode, Post } from '@nestjs/common';

function RotaDeEscrita(caminho: string) {
  return applyDecorators(Post(caminho), HttpCode(200));
}

@Controller('ficticio-composto')
export class DecoratorCompostoController {
  @RotaDeEscrita('x')
  escrever(): void {
    return undefined;
  }
}
