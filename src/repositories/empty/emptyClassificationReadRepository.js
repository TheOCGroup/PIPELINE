import { ClassificationReadRepository } from "../classificationReadRepository.js";

export class EmptyClassificationRepository extends ClassificationReadRepository {
  async listAll() {
    return [];
  }

  async listHistory() {
    return [];
  }
}
