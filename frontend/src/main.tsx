import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {WagmiProvider} from "wagmi";
import App from "./App";
import {config} from "./config";

const root = createRoot(document.getElementById("root")!);
root.render(
    <StrictMode>
        <WagmiProvider config={config}>
            <App />
        </WagmiProvider>
    </StrictMode>,
);
