import type { ProcessMessage } from '../../../shared/contracts/processing.js';
import { ApiError } from '../../errors.js';
import { ItemRepository } from './item.repository.js';

export async function receiveItem(repository: ItemRepository, message: ProcessMessage) {
  try {
    return await repository.receive(message);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Sem gravação confirmada, não devolvemos um ACK de sucesso.
    throw new ApiError(503, 'RECEIVING_UNAVAILABLE', 'Não foi possível guardar o trabalho. Tente novamente.', { cause: error });
  }
}
