# Registro feito por estagiário: identificação do supervisor (desenho para o Guardião)

> 13/11/2026 · Maestro · **VETADO pelo Guardião** (`revisoes/2026-11-13-desenho-supervisor-do-estagiario.md`); refazer antes de qualquer código. **A base certa é a Res. COFFITO 414/2012, art. 1º §2º** (o "art. 2º §1º" da issue não existe), conferida em https://www.coffito.gov.br/nsite/?p=3177 em 13/11/2026: o registro traz a **identificação e a assinatura** do supervisor, que responde pelo serviço, e do estagiário. Então o supervisor **cofinaliza**; só identificar não basta. Faltam também o número do CREFITO no cadastro (art. 1º §1º VIII), a base de vínculo "supervisão" para o supervisor ler o que assina e o aceite da designação. O texto abaixo é a primeira versão, mantida como registro.

## Hoje

- `professionals` não sabe se a pessoa é estagiária nem quem a supervisiona.
- O atendimento guarda o autor (`author_user_id`) e o profissional do agendamento. A finalização grava o hash e quem finalizou.
- Um estagiário cadastrado como `profissional` registra e finaliza como qualquer profissional, e nada no registro diz quem responde por ele.

## Proposta

1. **No cadastro do profissional** (só o admin da clínica):
   - `estagiario` (booleano, padrão falso);
   - `supervisor_professional_id`: obrigatório quando `estagiario`. Precisa ser outro profissional ativo da mesma clínica e **não** estagiário.
   
   Constraint no banco: estagiário sem supervisor recusa, e o supervisor não pode ser ele mesmo. Trigger: o supervisor é da mesma clínica, está ativo e não é estagiário.
2. **No atendimento**, o supervisor vigente é **congelado** na abertura (`supervisor_professional_id` em `encounters`), como o sigilo da psicologia (B1 do #63). Trocar o supervisor depois não reescreve registros antigos.
3. **Na finalização** de registro de estagiário:
   - a identificação do supervisor entra no conteúdo do hash da finalização;
   - o DTO passa a trazer `supervisorId`, e a tela e o documento mostram "Supervisor: nome e registro".
4. **Trilha:** a abertura e a finalização gravam `supervisor_id` (id do profissional, já conhecido pela clínica). Mudar o supervisor de um estagiário é uma operação auditada (`trainee_supervisor_changed`).
5. **Se o supervisor fica inativo:** o estagiário não abre atendimento novo (409 `supervisor_inativo`) até o admin designar outro. Os registros já abertos ficam com o supervisor congelado.

## Perguntas para o Guardião

1. **Cofinalização:** basta identificar o supervisor (o que o art. 2º §1º pede, pela leitura da issue), ou o supervisor deve **cofinalizar** o registro do estagiário? A cofinalização deixaria o registro aberto até o supervisor agir.
2. Congelar o supervisor na abertura, e não na finalização, está certo?
3. Isso vale só para fisio e TO (COFFITO), ou também para psicologia (o CFP tem regra própria para estágio)? Se valer para a psicologia, o supervisor vê o conteúdo restrito ao autor?
4. Entra antes do piloto, ou a clínica do piloto não terá estagiário?

## Fora do escopo

Contrato de estágio, horas e avaliação do estagiário, e conta própria do supervisor no portal.
