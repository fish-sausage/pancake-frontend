import { useTranslation } from "@pancakeswap/localization";
import styled from "styled-components";
import { useDebounce } from "@pancakeswap/hooks";

import { AutoColumn, ColumnCenter } from "../../components/Column";
import { Spinner, Text } from "../../components";

const Wrapper = styled.div`
  width: 100%;
`;

const ConfirmedIcon = styled(ColumnCenter)`
  padding: 24px 0;
`;

export function ConfirmationPendingContent({
  pendingText,
  wallchainStatus,
}: {
  pendingText?: string;
  wallchainStatus?: string | undefined;
}) {
  const { t } = useTranslation();
  const deferrWallchainStatus = useDebounce(wallchainStatus, 500);

  return (
    <Wrapper>
      <ConfirmedIcon>
        <Spinner />
      </ConfirmedIcon>
      <AutoColumn gap="12px" justify="center">
        {pendingText ? (
          <>
            <Text fontSize="20px">{t("Waiting For Confirmation")}</Text>
            <AutoColumn gap="12px" justify="center">
              <Text bold small textAlign="center">
                {pendingText}
              </Text>
            </AutoColumn>
          </>
        ) : null}
        {deferrWallchainStatus === "found" && (
          <Text small color="textSubtle" textAlign="center" style={{ width: 256 }}>
            {t(
              "'A Bonus route provided by API is automatically selected for your trade to achieve the best price for your trade"
            )}
          </Text>
        )}
        <Text small color="textSubtle" textAlign="center">
          {t("Confirm this transaction in your wallet")}
        </Text>
      </AutoColumn>
    </Wrapper>
  );
}
