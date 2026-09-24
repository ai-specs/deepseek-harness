/** Account providers expose protocol settings without an API-key reference. */
import z from '@deepseek-ai/schemastery'
import { deepSeekConfigFields, ConfigWithApiKey as ProtocolConfig } from '@deepseek-ai/dsh-llm-deepseek'

/** Account route configuration; authentication comes exclusively from the account service. */
export type Config = Omit<ProtocolConfig, 'apiKeyEnv'>
export const Config = z.object(deepSeekConfigFields)
