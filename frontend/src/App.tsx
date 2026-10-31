import {useAccount, useConnect, useDisconnect, useSwitchChain} from "wagmi";
import {sepolia} from "wagmi/chains";
import {QUADRATIC_FUNDING_ADDRESS_SEPOLIA} from "./config";

export function App() {
    const {address, isConnected, chainId} = useAccount();
    const {connect} = useConnect();
    const {disconnect} = useDisconnect();
    const {switchChain} = useSwitchChain();

    const isSepolia = chainId === sepolia.id;
    const contractConfigured =
        QUADRATIC_FUNDING_ADDRESS_SEPOLIA !== "0x0000000000000000000000000000000000000000";

    return (
        <div style={{fontFamily: "system-ui, sans-serif", padding: 24, color: "#0f172a"}}>
            <h1>Quadratic Funding</h1>
            <p>Decentralized quadratic funding platform on Sepolia.</p>

            <section style={{margin: 24 0, border: "1px solid #e2e8f0", padding: 16, borderRadius: 12}}>
                <h2>Wallet</h2>
                {isConnected ? (
                    <>
                        <p>Account: {address}</p>
                        <p>
                            Network: {isSepolia ? "Sepolia" : chainId?.toString() ?? "unknown"}
                            {!isSepolia && " (switch to Sepolia)"}
                        </p>
                        <button onClick={disconnect}>Disconnect</button>
                        {!isSepolia && (
                            <button onClick={() => switchChain({chainId: sepolia.id})}>
                                Switch to Sepolia
                            </button>
                        )}
                    </>
                ) : (
                    <button onClick={() => connect({})}>Connect Wallet</button>
                )}
            </section>

            {contractConfigured ? (
                <section style={{margin: 24 0}}>
                    <h2>Contract</h2>
                    <p>Deployed: {QUADRATIC_FUNDING_ADDRESS_SEPOLIA}</p>
                </section>
            ) : (
                <p style={{color: "#ef4444"}}>
                    Contract address not configured. Deploy to Sepolia and update frontend/src/config.ts.
                </p>
            )}
        </div>
    );
}
