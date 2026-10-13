/**
 * Erros da criptografia de campo. Mensagens FIXAS: nunca carregam chave, texto cifrado, texto em
 * claro, AAD nem a mensagem do provedor (que pode trazer ARN e detalhes da requisição). Também não
 * encadeiam `cause`, para que um logger que percorra a cadeia não vaze nada.
 */
export class FieldCryptoError extends Error {
  override readonly name: string = 'FieldCryptoError';
}

/** Valor cifrado mal formado, adulterado, de outra clínica/coluna/linha ou com chave errada. */
export class FieldDecryptionError extends FieldCryptoError {
  override readonly name = 'FieldDecryptionError';
  constructor() {
    super('não foi possível decifrar o campo');
  }
}

/** Chave mestra ou de dados indisponível: destruída, inexistente ou provedor fora do ar. */
export class KeyUnavailableError extends FieldCryptoError {
  override readonly name = 'KeyUnavailableError';
  constructor() {
    super('chave de criptografia indisponível');
  }
}

/** A clínica ainda não tem chave provisionada: falha fechada, nunca grava o campo em claro. */
export class TenantKeyMissingError extends FieldCryptoError {
  override readonly name = 'TenantKeyMissingError';
  constructor() {
    super('a clínica não tem chave de dados ativa');
  }
}

/** A clínica teve as chaves destruídas (eliminação): não se provisiona chave nova em silêncio. */
export class TenantKeysDestroyedError extends FieldCryptoError {
  override readonly name = 'TenantKeysDestroyedError';
  constructor() {
    super('as chaves desta clínica foram destruídas');
  }
}

/** Referência de campo inválida (tabela/coluna/linha). */
export class InvalidFieldRefError extends FieldCryptoError {
  override readonly name = 'InvalidFieldRefError';
  constructor() {
    super('referência de campo inválida');
  }
}
