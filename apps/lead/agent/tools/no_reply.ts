// Ends a turn without a message, with a reason kept in the session's history. A wake-up that needs nothing from the
// lead ends this way: nobody is reading, and an explicit choice to stay quiet is easier to audit than an empty reply.
import { noReply } from "eve/tools/no_reply";

export default noReply;
