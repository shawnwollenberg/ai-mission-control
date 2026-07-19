import { ValidationFailedError } from "@/lib/application-errors";

export type TemplateStatus = "draft" | "published" | "deprecated";
export type TemplateTask = {
  key: string;
  name: string;
  instructions: string;
  expectedOutput: string;
  requiredCapabilities: string[];
  resourceInputs?: string[];
  timeoutSeconds?: number;
  riskLevel?: "low" | "moderate" | "high";
};
export type TemplateDefinition = {
  name: string;
  description: string;
  domain: string;
  defaultObjective: string;
  inputSchema: { required?: string[]; properties: Record<string, { type: string; resourceType?: string }> };
  tasks: TemplateTask[];
  dependencies: Array<{ task: string; dependsOn: string }>;
  defaults: Record<string, unknown>;
  artifactExpectations: string[];
};

export function validateTemplateDefinition(definition: TemplateDefinition) {
  if (!definition.name.trim() || !definition.domain.trim() || !definition.tasks.length)
    throw new ValidationFailedError("Template name, domain, and tasks are required");
  const keys = new Set(definition.tasks.map((task) => task.key));
  if (keys.size !== definition.tasks.length) throw new ValidationFailedError("Template task keys must be unique");
  for (const edge of definition.dependencies)
    if (!keys.has(edge.task) || !keys.has(edge.dependsOn) || edge.task === edge.dependsOn)
      throw new ValidationFailedError("Template dependency is invalid");
}

export function validateTemplateInputs(schema: TemplateDefinition["inputSchema"], input: Record<string, unknown>) {
  const unknown = Object.keys(input).filter((key) => !(key in schema.properties));
  if (unknown.length)
    throw new ValidationFailedError("Template input contains unsupported fields", { fields: unknown });
  for (const required of schema.required ?? [])
    if (input[required] === undefined || input[required] === "")
      throw new ValidationFailedError(`Template input is required: ${required}`);
  for (const [key, value] of Object.entries(input)) {
    const expected = schema.properties[key].type;
    if (expected === "string" && typeof value !== "string")
      throw new ValidationFailedError(`Template input ${key} must be a string`);
    if (expected === "boolean" && typeof value !== "boolean")
      throw new ValidationFailedError(`Template input ${key} must be a boolean`);
    if (expected === "array" && !Array.isArray(value))
      throw new ValidationFailedError(`Template input ${key} must be an array`);
    if (expected === "resource_id" && (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)))
      throw new ValidationFailedError(`Template input ${key} must reference a registered resource`);
  }
  return structuredClone(input);
}
