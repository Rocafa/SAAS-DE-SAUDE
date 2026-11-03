/** Fixture FICTÍCIO (R6 do #117): handlers fora de controller que a análise tem de enxergar. Não é registrado. */
import type { INestApplication } from '@nestjs/common';

declare const app: INestApplication;
declare const loginDeTerceiro: (req: unknown, res: unknown, next: () => void) => void;

export function montar(): void {
  app.use(loginDeTerceiro);
  app.getHttpAdapter().post('/api/auth/entrar', () => undefined);
  void app.get(Object);
}
