import {
  validateTemplateDefinition,
  type TemplateDefinition
} from './template-definition'

export class TemplateRegistry {
  private readonly templates = new Map<string, TemplateDefinition>()

  register(definition: TemplateDefinition): void {
    const errors = validateTemplateDefinition(definition)
    if (errors.length > 0) throw new Error(errors.join('；'))
    if (this.templates.has(definition.id)) throw new Error(`模板 ${definition.id} 已存在`)
    this.templates.set(definition.id, structuredClone(definition))
  }

  get(id: string): TemplateDefinition {
    const definition = this.templates.get(id)
    if (!definition) throw new Error(`找不到模板 ${id}`)
    return structuredClone(definition)
  }

  list(): TemplateDefinition[] {
    return [...this.templates.values()].map((definition) => structuredClone(definition))
  }
}
